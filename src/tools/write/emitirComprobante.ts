// =============================================================================
// biller_emitir_comprobante  ->  POST /v3/comprobantes/emitir  (ESCRITURA)
//
// ⚠️ Emite un CFE REAL ante DGI (en test, contra DGI de test). Dos fases:
// dry-run (default) y ejecución con confirm=true + confirmation_token.
//
// El cuerpo se valida contra `ComprobanteBodySchema`, que tipa la "Tabla de
// valores" completa de la doc. El dry-run además calcula el total estimado para
// que la confirmación no sea a ciegas.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ComprobanteBodySchema,
  TIPOS_COMPROBANTE,
  validarComprobante,
  type ComprobanteBody,
} from "../../biller/cfeSchema.js";
import { normalizarTelefono } from "../../config.js";
import { WRITE_PATHS } from "../../constants.js";
import { resolverClaveSesion } from "../../kapso/borradorStore.js";
import { KapsoClient } from "../../kapso/client.js";
import { construirConfirmacionEmision } from "../../kapso/menu.js";
import { calcularTotales } from "../../services/calcularTotales.js";
import { buscarPorNumeroInterno } from "../../services/dedupe.js";
import {
  WRITE_ANNOTATIONS,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "../shared.js";
import {
  aplicarSucursalPorDefecto,
  runWriteOperation,
  writeControlShape,
  writeOutputShape,
} from "./shared.js";

const ENDPOINT = WRITE_PATHS.comprobantesEmitir;

/**
 * Total del comprobante expresado en pesos, para poder contrastarlo contra un
 * umbral que está definido en Unidades Indexadas.
 *
 * Si la moneda no es UYU y no hay `tasa_cambio` en el cuerpo, devuelve null: no
 * se estima una cotización. Un umbral evaluado con una tasa inventada puede
 * decir "no hace falta receptor" sobre una factura que sí lo necesitaba.
 */
export function totalEnPesos(body: ComprobanteBody, total: number): number | null {
  const moneda = (body.moneda ?? "UYU").toUpperCase();
  if (moneda === "UYU") return total;
  const tasa = body.tasa_cambio;
  if (typeof tasa === "number" && Number.isFinite(tasa) && tasa > 0) return total * tasa;
  return null;
}

const inputShape = {
  comprobante: ComprobanteBodySchema.describe(
    "Cuerpo del CFE según la Tabla de Valores de Biller: tipo_comprobante (obligatorio), forma_pago, " +
      "sucursal, moneda, montos_brutos, cliente, items[], descuentosRecargos[], referencias[], etc. " +
      "Las fechas van en dd/mm/aaaa.",
  ),
  verificar_duplicado: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Antes de emitir, consulta si ya existe un comprobante con el mismo numero_interno. " +
        "Es la única defensa real contra emitir dos veces por un reintento.",
    ),
  confirmar_por_whatsapp: z
    .string()
    .optional()
    .describe(
      "Solo en dry-run: manda el preview a este número de WhatsApp como dos botones " +
        "[Emitir] / [Cancelar], con el total calculado y el confirmation_token adentro del botón. " +
        "Es la forma de aprobar una emisión desde el teléfono. El número debe estar en la allowlist.",
    ),
  sesion: z
    .string()
    .optional()
    .describe(
      "El `sesion.id` que devolvió biller_emision_guiada (o el mismo identificador que le pasaste). " +
        "Preferí el id: es exacto, y un teléfono escrito de dos formas son dos sesiones distintas. " +
        "Cuando el comprobante se emite de verdad, el borrador guardado de esa sesión se descarta. " +
        "Pasalo SIEMPRE que hayas venido de la emisión guiada: sin esto, el borrador viejo sigue " +
        "vivo 24 h y la próxima factura arranca con el cliente y los ítems de la anterior.",
    ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

/**
 * Completa, DESDE el borrador guardado, los textos que la barrera de salida no
 * deja viajar por el modelo: el `concepto` de cada ítem y la `adenda`.
 *
 * Es la otra mitad de `repetir_ultima_de` (y del borrador en general): esos
 * textos están en el store del server porque no pueden volver en una respuesta
 * sin quedar envueltos en ⟦dato-no-confiable⟧. El agente manda los ítems SIN
 * concepto, y acá se rellenan por posición antes de validar — antes, porque
 * `ItemSchema` exige concepto y un payload incompleto no pasaría del parseo.
 *
 * Solo COMPLETA, nunca pisa: un concepto que el agente sí mandó (el usuario lo
 * cambió a último momento) le gana al guardado.
 */
function completarDesdeSesion(args: unknown, ctx: ToolContext): void {
  if (typeof args !== "object" || args === null) return;
  const a = args as { sesion?: unknown; comprobante?: { items?: unknown; adenda?: unknown } };
  if (typeof a.sesion !== "string" || a.sesion.trim() === "") return;
  if (typeof a.comprobante !== "object" || a.comprobante === null) return;

  const guardado = ctx.getBorradorStore().leer(resolverClaveSesion(a.sesion));
  if (guardado === null) return;

  const itemsGuardados = guardado.estado.items ?? [];
  const items = a.comprobante.items;
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] as { concepto?: unknown };
      if (typeof item !== "object" || item === null) continue;
      const conceptoGuardado = itemsGuardados[i]?.concepto;
      if (
        (item.concepto === undefined || item.concepto === "") &&
        conceptoGuardado !== undefined &&
        conceptoGuardado !== ""
      ) {
        item.concepto = conceptoGuardado;
      }
    }
  }

  if (
    (a.comprobante.adenda === undefined || a.comprobante.adenda === "") &&
    guardado.estado.adenda !== undefined &&
    guardado.estado.adenda.trim() !== ""
  ) {
    a.comprobante.adenda = guardado.estado.adenda;
  }
}

export async function handleEmitirComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  completarDesdeSesion(args, ctx);
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: ComprobanteBody = { ...a.comprobante };
  aplicarSucursalPorDefecto(payload, ctx);

  // Los totales se calculan ANTES de validar porque una de las reglas de DGI
  // —identificar al receptor por encima de 5.000 UI— depende del importe, no
  // solo de los campos del cuerpo. Sin el total, esa regla no se puede evaluar.
  const totales = calcularTotales(payload);
  const totalUyu = totalEnPesos(payload, totales.total);

  let cfg: { valorUi?: number; valorUiFecha?: string; umbralUi?: number } = {};
  try {
    const c = ctx.getConfig();
    cfg = { valorUi: c.valorUi, valorUiFecha: c.valorUiFecha, umbralUi: c.umbralUiReceptor };
  } catch {
    // Sin config no se puede leer el valor de la UI: la regla se evalúa igual
    // con el valor de referencia y lo declara.
  }

  const warnings = validarComprobante(payload, {
    total_uyu: totalUyu,
    valor_ui: cfg.valorUi,
    valor_ui_fecha: cfg.valorUiFecha,
    umbral_ui: cfg.umbralUi,
  });

  // Sucursal: Biller la exige. En dry-run avisamos; en execute bloqueamos con un
  // mensaje claro en vez de dejar que la API devuelva un 422 confuso.
  if (payload.sucursal === undefined && a.confirm) {
    return simpleErrorResult(
      "Falta 'sucursal': Biller la exige para emitir un comprobante. Pasá 'sucursal' en el cuerpo " +
        "o configurá BILLER_DEFAULT_SUCURSAL_ID con el ID real de tu sucursal (Ajustes → Sucursales en biller.uy).",
      ctx,
    );
  }

  // --- Deduplicación contra la API ----------------------------------------
  // La idempotencia in-process se pierde al reiniciar el server. Esta consulta
  // pregunta a Biller si el numero_interno ya se usó, que es lo único que
  // sobrevive a un reinicio o a un reintento desde otro proceso.
  if (a.confirm && a.verificar_duplicado && payload.numero_interno !== undefined) {
    try {
      const existente = await buscarPorNumeroInterno(ctx, payload.numero_interno);
      if (existente !== null) {
        return simpleErrorResult(
          `Ya existe un comprobante con numero_interno "${payload.numero_interno}" ` +
            `(id ${existente.id ?? "?"}, ${existente.serie ?? ""}-${existente.numero ?? ""}, ` +
            `total ${existente.moneda ?? ""} ${existente.total ?? "?"}). ` +
            "No se emitió nada para evitar un duplicado ante DGI. Si querés emitir otro comprobante, " +
            "usá un numero_interno distinto.",
          ctx,
        );
      }
    } catch (err) {
      warnings.push(
        "No se pudo verificar si el numero_interno ya existe (falló la consulta previa): " +
          `${err instanceof Error ? err.message : String(err)}. Se continúa sin esa verificación.`,
      );
    }
  }

  warnings.push(...totales.advertencias);

  // --- ¿La sesión que me pasaron existe? -----------------------------------
  //
  // Se chequea ACÁ, antes de emitir, y no después: en el dry-run el agente
  // todavía puede corregir el identificador; después del POST el CFE ya existe
  // y el aviso es una autopsia.
  //
  // Un borrador que no se borra no invalida nada, pero es el que le va a meter
  // el cliente y los ítems de ESTA factura a la siguiente. Por eso se avisa
  // fuerte en vez de fallar: fallar la emisión por un borrador colgado sería
  // peor que el problema.
  const claveSesion_ =
    a.sesion === undefined || a.sesion.trim() === "" ? null : resolverClaveSesion(a.sesion);
  if (claveSesion_ !== null && ctx.getBorradorStore().leer(claveSesion_) === null) {
    warnings.push(
      "No hay ningún borrador guardado con esa 'sesion', así que al emitir no se va a borrar nada. " +
        "Suele ser porque el identificador llegó escrito distinto que en biller_emision_guiada. Usá " +
        "el `sesion.id` que devuelve esa tool, que es exacto — si no, el borrador viejo sigue vivo " +
        "24 h y la próxima factura arranca con el cliente y los ítems de esta.",
    );
  }

  const resultado = await runWriteOperation({
    ctx,
    tool: "biller_emitir_comprobante",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    remitente: a.remitente,
    rateLimitClass: "dgi", // creación de comprobantes: 1 req/seg
    warnings,
    totalesEstimados: totales,
  });

  // El borrador se descarta cuando el CFE existe, no antes.
  //
  // Va DESPUÉS de `runWriteOperation` y condicionado a que no haya error: si se
  // borrara en el dry-run, o ante un 422, el usuario perdería la conversación
  // entera justo cuando hay que arreglar un campo y reintentar — que es
  // exactamente el momento en que el borrador vale más.
  //
  // Y la condición se mira en el RESULTADO, no en `a.confirm`: un confirm puede
  // terminar en dry-run (gate cerrado), o ejecutar y volver con un 422 sin que
  // `isError` sea true. La primera versión de esto miraba `isError` y borraba el
  // borrador de una emisión rechazada por la API — el peor momento posible. La
  // única señal honesta es "modo ejecutado Y status 2xx".
  const sc = resultado.structuredContent;
  const status = typeof sc?.["http_status"] === "number" ? (sc["http_status"] as number) : 0;
  const emitido = sc?.["mode"] === "executed" && status >= 200 && status < 300;

  if (emitido && claveSesion_ !== null) ctx.getBorradorStore().borrar(claveSesion_);

  // EL FINAL DEL EMBUDO.
  //
  // `emision.paso` cuenta dónde queda cada conversación; esto cuenta cómo
  // terminan. Sin las dos mitades, el embudo dice "88 de 100 no llegaron a
  // confirmar" pero no dice cuántas de las 12 que llegaron terminaron en un CFE
  // y cuántas se cayeron en la API — que son dos problemas distintos, con dos
  // arreglos distintos.
  //
  // El desenlace es un vocabulario de tres palabras, no el status HTTP: un 422
  // y un 500 son "rechazado" para esta pregunta, y el número exacto ya está en
  // el audit log, que es donde corresponde buscarlo.
  ctx.metricas.contar("emision.desenlace", {
    desenlace: !a.confirm ? "preview" : emitido ? "emitido" : "rechazado",
  });

  if (a.confirmar_por_whatsapp === undefined) return resultado;
  return await adjuntarConfirmacionWhatsapp(resultado, {
    ctx,
    destinatario: a.confirmar_por_whatsapp,
    confirm: a.confirm,
    payload,
  });
}

/**
 * Manda el preview del dry-run como botones de WhatsApp.
 *
 * Se hace DESPUÉS de `runWriteOperation` y sobre su resultado, no adentro, por
 * una razón concreta: así el mensaje lleva EXACTAMENTE el `confirmation_token`
 * y el `resumen` que devolvió el preview. Si se recalcularan acá podrían
 * divergir del que el usuario tiene delante — y el punto de todo el mecanismo
 * es que lo que se aprueba y lo que se ejecuta sean lo mismo.
 *
 * El token va dentro del id del botón. No es un secreto (está ligado al payload
 * por hash, no es una credencial), y es lo que hace que tocar "Emitir" sea
 * indistinguible de confirmar el preview leído.
 */
async function adjuntarConfirmacionWhatsapp(
  resultado: ToolResult,
  p: {
    ctx: ToolContext;
    destinatario: string;
    confirm: boolean;
    payload: ComprobanteBody;
  },
): Promise<ToolResult> {
  const structured = resultado.structuredContent;
  const info = (clave: string): unknown => (structured === undefined ? undefined : structured[clave]);

  const fallar = (motivo: string): ToolResult => {
    if (structured === undefined) return resultado;
    const previos = Array.isArray(structured["warnings"]) ? (structured["warnings"] as string[]) : [];
    return jsonResult({
      ...structured,
      confirmacion_whatsapp: { enviado: false, motivo },
      warnings: [...previos, motivo],
    });
  };

  if (resultado.isError === true || structured === undefined) return resultado;

  if (p.confirm) {
    return fallar(
      "confirmar_por_whatsapp se ignoró: solo aplica al dry-run. Con confirm=true el comprobante ya " +
        "se emitió; no hay nada que confirmar.",
    );
  }

  const token = info("confirmation_token");
  const resumen = info("resumen");
  if (typeof token !== "string" || typeof resumen !== "string") {
    return fallar(
      "No se mandó la confirmación por WhatsApp: el preview no devolvió token o resumen. " +
        "El dry-run es válido igual; confirmá por este canal.",
    );
  }

  try {
    const config = p.ctx.getConfig();
    if (config.kapso === undefined) {
      return fallar(
        "No se mandó la confirmación por WhatsApp: falta KAPSO_API_KEY. El preview es válido igual.",
      );
    }

    const destino = normalizarTelefono(p.destinatario);
    const kapso = new KapsoClient(config.kapso);
    const envio = await kapso.enviarInteractivo(
      destino,
      construirConfirmacionEmision({
        resumen,
        cliente: nombreCliente(p.payload.cliente),
        tipoComprobante: TIPOS_COMPROBANTE[p.payload.tipo_comprobante],
        ambiente: config.environment,
        token,
      }),
    );

    return jsonResult({
      ...structured,
      confirmacion_whatsapp: {
        enviado: true,
        destinatario_sufijo: destino.slice(-4),
        message_id: envio.message_id,
        instruccion:
          "El usuario tiene el preview en el teléfono. Si toca ✅ Emitir vas a recibir un id que " +
          `empieza con "emitir:si:" seguido del confirmation_token: llamá a biller_emitir_comprobante ` +
          "con confirm=true y ESE token, sin cambiar nada del cuerpo. Si toca ✖️ Cancelar, no emitas.",
      },
    });
  } catch (err) {
    return fallar(
      "No se pudo mandar la confirmación por WhatsApp: " +
        `${err instanceof Error ? err.message : String(err)}. El preview es válido igual — ` +
        "el dry-run no ejecutó nada.",
    );
  }
}

/** Razón social del receptor para el mensaje. `cliente` puede ser string u objeto. */
function nombreCliente(cliente: ComprobanteBody["cliente"]): string | undefined {
  if (typeof cliente === "string") return cliente.trim() === "" ? undefined : cliente;
  if (cliente === undefined || cliente === null) return undefined;
  const razon = (cliente as { razon_social?: unknown }).razon_social;
  return typeof razon === "string" && razon.trim() !== "" ? razon : undefined;
}

export function registerEmitirComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_emitir_comprobante",
    {
      title: "Emitir comprobante (CFE) — ESCRITURA",
      description:
        "EMITE un CFE real ante DGI (POST /v3/comprobantes/emitir). Por defecto hace dry-run (preview) sin red, " +
        "devolviendo el payload validado y el TOTAL ESTIMADO. Para ejecutar requiere confirm=true + " +
        "confirmation_token, BILLER_WRITE_ENABLED=true y, en producción, allow_production=true. " +
        "Valida la Tabla de Valores completa (tipos de CFE, indicador_facturacion, exportación, remitos, " +
        "referencias) y verifica que el numero_interno no esté repetido.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Emitir comprobante (escritura)" },
    },
    async (args) => handleEmitirComprobante(args, ctx),
  );
}
