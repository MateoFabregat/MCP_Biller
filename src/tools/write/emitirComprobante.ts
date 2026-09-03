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
import { identidadDeConversacion, rechazoSesionAjena } from "../../security/remitentes.js";
import { WRITE_PATHS } from "../../constants.js";
import { KapsoClient } from "../../kapso/client.js";
import { construirConfirmacionEmision } from "../../kapso/menu.js";
import { calcularTotales } from "../../services/calcularTotales.js";
import { hoyDgiUy } from "../../services/fechaUy.js";
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
function completarDesdeSesion(args: unknown, ctx: ToolContext, identidad: string | null): DatosDeSesion {
  const vacio: DatosDeSesion = { precios_ambiguos: [], avisos: [] };
  const avisos: string[] = [];
  if (typeof args !== "object" || args === null) return vacio;
  const a = args as {
    sesion?: unknown;
    comprobante?: { items?: unknown; adenda?: unknown; numero_interno?: unknown };
  };
  if (typeof a.sesion !== "string" || a.sesion.trim() === "") return vacio;
  if (typeof a.comprobante !== "object" || a.comprobante === null) return vacio;

  // NO se abre `a.sesion` sino la identidad que resolvió `identidadDeConversacion`
  // en el handler: con el canal de WhatsApp abierto es el remitente que verificó
  // la barrera, y un `sesion` ajeno ya fue rechazado antes de llegar acá. Esta es
  // la línea por la que el remitente A completaba las líneas de su CFE —un
  // documento fiscal REAL— con los conceptos del borrador de B.
  if (identidad === null) return vacio;

  const guardado = ctx.getBorradorStore().leer(ctx.getBorradorStore().clave(identidad));
  if (guardado === null) return vacio;

  const preciosAmbiguos: DatosDeSesion["precios_ambiguos"] = [];
  const itemsGuardados = guardado.estado.items ?? [];
  const items = a.comprobante.items;
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] as { concepto?: unknown; precio?: unknown };
      if (typeof item !== "object" || item === null) continue;
      const guardadoItem = itemsGuardados[i];
      const conceptoGuardado = guardadoItem?.concepto;
      if (
        (item.concepto === undefined || item.concepto === "") &&
        conceptoGuardado !== undefined &&
        conceptoGuardado !== ""
      ) {
        item.concepto = conceptoGuardado;
      }

      // LA MARCA DE AMBIGÜEDAD VIAJA POR ACÁ Y NO POR EL PAYLOAD.
      //
      // `precio_ambiguo` no es un campo del CFE: no puede ir en el cuerpo. Pero
      // tiene que llegar al preview, que es lo único que el humano lee antes de
      // emitir. Sale del store —donde lo dejó la emisión guiada— y entra al
      // `contextoPreview`, que no se hashea porque no se envía.
      //
      // Se exige que el precio SIGA SIENDO el mismo: si el agente mandó otro, el
      // usuario lo corrigió y la duda ya no existe. Advertir sobre un precio que
      // se cambió sería ruido, y el ruido es lo que hace que se dejen de leer
      // las advertencias que sí importan.
      const precioPayload = typeof item.precio === "number" ? item.precio : Number(item.precio);
      if (
        guardadoItem?.precio_ambiguo === true &&
        guardadoItem.precio !== undefined &&
        Number.isFinite(precioPayload) &&
        precioPayload === guardadoItem.precio
      ) {
        const concepto = typeof item.concepto === "string" ? item.concepto : conceptoGuardado;
        preciosAmbiguos.push({
          ...(concepto !== undefined ? { concepto } : {}),
          precio: guardadoItem.precio,
        });
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

  // EL `numero_interno` LO PONE EL SERVER, NO EL MODELO.
  //
  // Está en CAMPOS_NO_CONFIABLES, así que si volviera en el borrador volvería
  // envuelto en ⟦dato-no-confiable⟧ — y el modelo o lo copiaba con las marcas
  // adentro, o las limpiaba a mano. Lo segundo es peor: dos reintentos que
  // limpian distinto producen dos ids distintos, `buscarPorNumeroInterno` no
  // matchea ninguno, y la misma venta sale DOS VECES ante DGI. Por eso el id
  // vive en el store y se completa acá: el único camino que no pasa por el
  // canal del modelo. Ver `borradorComprobante` en tools/emisionGuiada.ts.
  //
  // ES LA ÚNICA EXCEPCIÓN A "SOLO COMPLETA, NUNCA PISA", y por el mismo motivo
  // por el que existe: si un numero_interno traído por el modelo le ganara al
  // del borrador, el invariante que este campo garantiza —dos intentos de la
  // MISMA venta llevan el MISMO id— dependería otra vez de que el modelo
  // copiara bien. Un id distinto por intento es exactamente el duplicado ante
  // DGI que se está evitando. Para emitir OTRO comprobante hay otra sesión.
  const guardadoNI = guardado.estado.numero_interno;
  if (guardadoNI !== undefined && guardadoNI !== "") {
    if (
      typeof a.comprobante.numero_interno === "string" &&
      a.comprobante.numero_interno !== "" &&
      a.comprobante.numero_interno !== guardadoNI
    ) {
      avisos.push(
        "El 'numero_interno' que venía en el cuerpo se reemplazó por el del borrador de esa " +
          "sesión: lo genera el server y es lo que hace que un reintento no emita dos veces. " +
          "No hace falta que lo mandes.",
      );
    }
    a.comprobante.numero_interno = guardadoNI;
  }

  return { precios_ambiguos: preciosAmbiguos, avisos };
}

/** Lo que el borrador guardado aporta y el payload no puede transportar. */
interface DatosDeSesion {
  precios_ambiguos: Array<{ concepto?: string; precio: number }>;
  /** Lo que hubo que corregir del cuerpo que llegó. Va a `warnings`. */
  avisos: string[];
}

export async function handleEmitirComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  // --- DE QUIÉN ES LA SESIÓN, ANTES QUE NADA -------------------------------
  //
  // Va arriba de todo, antes de leer el borrador y muy antes del POST, porque acá
  // `sesion` decide TRES cosas y las tres son caras: con qué conceptos y con qué
  // `numero_interno` se completa el CFE que se emite (`completarDesdeSesion`), y
  // qué borrador se BORRA cuando la emisión sale bien. Un chequeo que solo
  // cubriera la lectura dejaría vivo el camino por el que A, al emitir lo suyo,
  // le borra a B la factura que estaba cargando.
  //
  // Cubre el ciclo entero: el dry-run y el confirm son dos llamadas a esta misma
  // función y las dos pasan por acá, así que no hay forma de resolver la sesión
  // con un remitente y ejecutarla con otro.
  //
  // Solo se resuelve cuando vino `sesion`: sin sesión no se lee ni se borra
  // ningún borrador, o sea que no hay nada que autorizar, y exigir el remitente
  // ahí rompería la emisión directa —la que no viene de la guiada— sin cerrar
  // nada. La decisión es de `security/remitentes.ts`: es la misma que toman la
  // emisión guiada y el menú.
  const sesionCruda =
    typeof (args as { sesion?: unknown } | null)?.sesion === "string"
      ? ((args as { sesion: string }).sesion)
      : undefined;
  const identidadSesion =
    sesionCruda === undefined || sesionCruda.trim() === ""
      ? ({ ok: true, identidad: null } as const)
      : identidadDeConversacion(
          sesionCruda,
          typeof (args as { remitente?: unknown } | null)?.remitente === "string"
            ? ((args as { remitente: string }).remitente)
            : undefined,
          () => ctx.getConfig(),
          (b) => ctx.getBorradorStore().clave(b),
        );
  if (!identidadSesion.ok) return rechazoSesionAjena(identidadSesion.mensaje, ctx);

  const deSesion = completarDesdeSesion(args, ctx, identidadSesion.identidad);
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
  // La idempotencia persistente protege la key local; esta consulta suma una
  // segunda defensa de negocio preguntando si `numero_interno` ya fue usado en
  // Biller, incluso frente a otro cliente o una key distinta.
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
    } catch {
      // Si no podemos demostrar que el identificador está libre, no emitimos.
      // Continuar convertía una caída transitoria del GET en un posible CFE
      // duplicado. Tampoco devolvemos el texto crudo del upstream: es contenido
      // externo y no hace falta para que el usuario sepa cómo recuperarse.
      return simpleErrorResult(
        `No se pudo verificar si el numero_interno "${payload.numero_interno}" ya existe. ` +
          "No se emitió nada: reintentá cuando la consulta de Biller vuelva a estar disponible.",
        ctx,
      );
    }
  }

  warnings.push(...totales.advertencias);
  warnings.push(...deSesion.avisos);

  // El precio ambiguo también sale como warning, además de estar escrito en el
  // resumen: el resumen lo lee el humano por WhatsApp y esto lo lee el agente,
  // que es quien puede repreguntar antes de mandar el preview.
  for (const p of deSesion.precios_ambiguos) {
    warnings.push(
      `⚠️ El precio ${p.precio} ${p.concepto === undefined ? "" : `de "${p.concepto}" `}` +
        "quedó marcado como AMBIGUO al leerlo (admite otra lectura con 100x de diferencia). " +
        "Está escrito en el resumen del preview: no confirmes sin que el usuario lo ratifique.",
    );
  }

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
  //
  // La clave sale de la IDENTIDAD resuelta arriba y no del `sesion` crudo, que es
  // lo que hace que el borrado del final caiga siempre sobre el borrador propio.
  // Se sigue exigiendo que haya venido `sesion`, porque mandarlo es lo que
  // declara que esta emisión viene de la guiada: sin eso, un POST directo del
  // mismo usuario le comería el borrador que tiene a medio cargar en otra
  // conversación.
  const claveSesion_ =
    a.sesion === undefined || a.sesion.trim() === "" || identidadSesion.identidad === null
      ? null
      : ctx.getBorradorStore().clave(identidadSesion.identidad);
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
    // EL TOPE DE MONTO NECESITA QUE ALGUIEN LE DIGA CUÁL ES EL TOTAL.
    //
    // `extraerMonto` busca `total`/`monto`/`importe` en la raíz del payload, y
    // un ComprobanteBody no tiene ninguno de los tres: el total de un CFE es la
    // suma de sus líneas. O sea que BILLER_MAX_MONTO_UYU no limitaba nunca la
    // emisión — justo la operación para la que el tope existe (una coma mal
    // puesta en un precio). El número ya está calculado unas líneas arriba; lo
    // único que faltaba era pasarlo.
    montoExplicito: { monto: totales.total, moneda: (payload.moneda ?? "UYU").toUpperCase() },
    // Los supuestos del preview salen del MISMO payload que se hashea, no de
    // una descripción aparte: no hay forma de que el mensaje diga "contado" y
    // se emita a crédito. `hoy` entra para poder escribir "Hoy 26/08/2026", y
    // sale de `fechaUy` y no de `new Date()` por lo de siempre (ver fechaUy.ts).
    contextoPreview: {
      ...(payload.fecha_emision !== undefined ? { fecha_emision: payload.fecha_emision } : {}),
      ...(payload.forma_pago !== undefined ? { forma_pago: payload.forma_pago } : {}),
      ...(payload.fecha_vencimiento !== undefined
        ? { fecha_vencimiento: payload.fecha_vencimiento }
        : {}),
      ...(payload.montos_brutos !== undefined ? { montos_brutos: payload.montos_brutos } : {}),
      // La única parte del preview que NO sale del payload, y no puede salir de
      // ahí: `precio_ambiguo` no es un campo del CFE. Ver `completarDesdeSesion`.
      ...(deSesion.precios_ambiguos.length > 0
        ? { precios_ambiguos: deSesion.precios_ambiguos }
        : {}),
      // Este aviso tiene que verlo la persona ANTES de los importes. Dejarlo
      // solo en `warnings` estructurado hacía que el agente lo conociera, pero
      // el preview de WhatsApp no lo mostrara.
      advertencias_criticas: warnings.filter((w) =>
        /RECEPTOR OBLIGATORIO|DGI exige receptor identificado/i.test(w),
      ),
      hoy: hoyDgiUy(),
    },
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
    actorIdentity: a.remitente,
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
    actorIdentity?: string;
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
        documento: documentoCliente(p.payload.cliente),
        tipoComprobante: TIPOS_COMPROBANTE[p.payload.tipo_comprobante],
        ambiente: config.environment,
        token,
      }),
      { actorIdentity: p.actorIdentity, operation: "confirmacion_emision" },
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
  if (typeof razon === "string" && razon.trim() !== "") return razon;
  // Con cédula el nombre principal va en `nombre_fantasia`, no en `razon_social`
  // (ver el `completar` de emisionGuiada). Sin este fallback, el preview de un
  // e-Ticket identificado no decía a nombre de quién salía.
  const fantasia = (cliente as { nombre_fantasia?: unknown }).nombre_fantasia;
  return typeof fantasia === "string" && fantasia.trim() !== "" ? fantasia : undefined;
}

/** RUT o CI del receptor, para el encabezado del preview. Se enmascara al mostrarlo. */
function documentoCliente(cliente: ComprobanteBody["cliente"]): string | undefined {
  if (typeof cliente !== "object" || cliente === null) return undefined;
  const doc = (cliente as { documento?: unknown }).documento;
  return typeof doc === "string" && doc.trim() !== "" ? doc : undefined;
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
