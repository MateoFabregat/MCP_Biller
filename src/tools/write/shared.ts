// =============================================================================
// Runner compartido para las tools de ESCRITURA ("escritura con barreras").
//
// Patrón de dos fases:
//   - confirm=false (default) -> DRY-RUN: valida, arma el payload, devuelve un
//     preview + confirmation_token. NO hace ninguna llamada de red.
//   - confirm=true            -> EJECUTA: verifica el token contra el payload,
//     pasa por el gate + idempotencia + audit, y recién ahí hace el POST.
// =============================================================================

import { z } from "zod";
import {
  formatearTotales,
  type ContextoPreview,
  type TotalesEstimados,
} from "../../services/calcularTotales.js";
import { createHash } from "node:crypto";
import { limpiarMarcasProfundo } from "../../security/untrusted.js";
import { rechazoSesionAjena, requiereRemitente } from "../../security/remitentes.js";
import { normalizarTelefono } from "../../config.js";
import type { RateLimitClass } from "../../utils/rateLimit.js";
import { BillerConfirmationError } from "../../utils/errors.js";
import { checkConfirmationToken, computeConfirmationToken } from "../../write/confirm.js";
import { executeWrite } from "../../write/execute.js";
import { evaluateWriteGate } from "../../write/gate.js";
import { generateIdempotencyKey } from "../../write/idempotency.js";
import { verificarLimiteMonto, type MontoExplicito } from "../../write/limiteMonto.js";
import { errorToolResult, jsonResult, type ToolContext, type ToolResult } from "../shared.js";

// El preview existe para que un humano verifique A QUIÉN le está facturando.
// Ocultar del todo el receptor (documento/razón social) hacía que confirmar una
// e-Factura fuera imposible de auditar: se podía aprobar una factura al cliente
// equivocado sin forma de notarlo. Por eso se ENMASCARA parcialmente en vez de
// redactar: queda suficiente para reconocer al cliente, no para copiarlo entero.
//
// tipo_documento es un código de categoría numérico (2=RUT, 3=CI): no es PII por
// sí mismo, así que no se toca.
const CAMPOS_ENMASCARADOS = new Set([
  "rut", "documento", "email", "telefono", "direccion", "domicilio",
]);

/** Deja visible el inicio del valor y enmascara la cola: "2149874400**". */
function enmascarar(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value.includes("@")) {
    // Email: usuario visible en parte + dominio completo (sirve para verificar).
    const [usuario, dominio] = value.split("@");
    const visible = usuario.slice(0, Math.min(3, usuario.length));
    return `${visible}${"*".repeat(Math.max(1, usuario.length - visible.length))}@${dominio}`;
  }
  if (value.length <= 4) return value;
  const visibles = Math.max(4, Math.ceil(value.length * 0.7));
  return value.slice(0, visibles) + "*".repeat(value.length - visibles);
}

function maskPayloadPreview(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(maskPayloadPreview);
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      CAMPOS_ENMASCARADOS.has(k) ? enmascarar(v) : maskPayloadPreview(v),
    ]),
  );
}

/**
 * Completa `sucursal` con BILLER_DEFAULT_SUCURSAL_ID si el cuerpo no la trae.
 * Tolera que la config no exista: en ese caso `runWriteOperation` es quien
 * devuelve el error de configuración, con un mensaje mejor que el que daríamos acá.
 */
export function aplicarSucursalPorDefecto(
  payload: { sucursal?: number },
  ctx: ToolContext,
): void {
  if (payload.sucursal !== undefined) return;
  try {
    const raw = ctx.getConfig().defaultSucursalId;
    if (raw === undefined) return;
    const n = Number(raw);
    if (Number.isFinite(n)) payload.sucursal = n;
  } catch {
    /* config inválida: el error lo reporta runWriteOperation */
  }
}

/** Campos de control comunes a todas las tools de escritura. */
export const writeControlShape = {
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe("false = dry-run/preview (SIN red). true = ejecuta el POST real."),
  confirmation_token: z
    .string()
    .optional()
    .describe("Token devuelto por el dry-run. Obligatorio cuando confirm=true."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Clave de idempotencia. Si se omite, se genera una automáticamente."),
  allow_production: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Doble confirmación para PRODUCCIÓN. Junto con BILLER_ALLOW_PRODUCTION_WRITES=true habilita el POST contra biller.uy.",
    ),
  /**
   * El mismo `remitente` que agrega la barrera de entrada, declarado también acá.
   *
   * La barrera lo inyecta en el input de TODA tool y lo verifica antes del
   * handler, pero cada tool parsea sus args con su propio `z.object`, que
   * descarta las claves que no declara. Sin esta línea el valor llega al server,
   * se valida, y se pierde antes de que el audit log pueda escribirlo — o sea:
   * se sabe quién pidió la emisión justo hasta el momento de anotarlo.
   */
  remitente: z
    .string()
    .optional()
    .describe("Teléfono de quien pide la operación. Queda enmascarado en el audit log."),
};

export const writeOutputShape = {
  mode: z.enum(["dry_run", "executed"]),
  tool: z.string(),
  endpoint: z.string(),
  environment: z.enum(["test", "production"]),
  method: z.literal("POST").optional(),
  write_enabled: z.boolean().optional(),
  gate: z
    .object({
      allowed: z.boolean(),
      reason: z.string().nullable(),
      requires_allow_production: z.boolean(),
    })
    .optional(),
  payload_preview: z.unknown().optional(),
  query_preview: z.unknown().optional(),
  confirmation_token: z.string().optional(),
  idempotency_key: z.string().nullable().optional(),
  next_step: z.string().optional(),
  no_network_call: z.boolean().optional(),
  http_status: z.number().optional(),
  response: z.unknown().optional(),
  audit_id: z.string().optional(),
  /** Totales calculados localmente en el dry-run de una emisión. */
  totales_estimados: z.unknown().optional(),
  /** Línea legible con el total, para la confirmación humana. */
  resumen: z.string().optional(),
  /** Resultado de haber mandado el preview como botones de WhatsApp (ver emitirComprobante). */
  confirmacion_whatsapp: z.unknown().optional(),
  warnings: z.array(z.string()),
};

export interface RunWriteParams {
  ctx: ToolContext;
  tool: string;
  endpoint: string;
  /** Cuerpo del POST (o undefined para endpoints sin body, p.ej. cancelar). */
  payload: unknown;
  query?: Record<string, string | number | undefined>;
  confirm: boolean;
  confirmationToken?: string;
  idempotencyKey?: string;
  allowProduction: boolean;
  rateLimitClass?: RateLimitClass;
  warnings?: string[];
  /**
   * Totales calculados localmente, a mostrar SOLO en el dry-run. No entran en el
   * hash del token: son derivados del payload, no parte de lo que se envía.
   */
  totalesEstimados?: TotalesEstimados;
  /**
   * Fecha, forma de pago y criterio de IVA, para la LÍNEA DE SUPUESTOS del
   * preview. Tampoco entra en el hash: sale del mismo payload que ya está
   * hasheado, así que no puede describir otra cosa que lo que se va a emitir.
   */
  contextoPreview?: ContextoPreview;
  /**
   * Quién pidió la operación. Va al audit log enmascarado Y —desde que el token
   * lleva identidad— ata el `confirmation_token` a esta conversación.
   *
   * ANTES ESTABA ANOTADO AL REVÉS: que no entrara al hash, para no romper "el
   * dueño arranca la factura y la confirma el encargado". Ese caso no es
   * legítimo, es el agujero: el payload queda congelado, así que el encargado no
   * puede cambiar QUÉ se emite, pero sí puede disparar la emisión del dueño, y
   * lo que sale es un CFE real con la numeración de la empresa. Aprobar por otro
   * es justo lo que el human-in-the-loop existe para impedir. El que quiera
   * emitir hace su propio dry-run y confirma sobre el preview que leyó él.
   *
   * Lo que entra al hash no es este valor sino su clave opaca: ver
   * `identidadDeEscritura`.
   */
  remitente?: string;
  /**
   * El total de la operación, para el tope de monto, cuando el payload no lo
   * lleva en la raíz. Un ComprobanteBody nunca lo lleva: el total de un CFE es
   * la suma de sus líneas. Ver `verificarLimiteMonto`.
   *
   * No entra en el hash del confirmation_token: es un derivado del mismo payload
   * que ya está hasheado, igual que `totalesEstimados`.
   */
  montoExplicito?: MontoExplicito;
}

/**
 * A QUIÉN PERTENECE ESTE TOKEN.
 *
 * VA ACÁ, en el runner, y no en cada tool: `runWriteOperation` es la única
 * costura por la que pasan las SIETE tools de escritura —emitir, anular, recibo,
 * pago, cliente, producto, cancelar recibo— y las dos fases del ciclo (el
 * dry-run que emite el token y el confirm que lo verifica) son dos llamadas a
 * esta misma función. Puesto acá, una tool de escritura nueva queda atada sin
 * que nadie se acuerde; puesto tool por tool, la que se olvide es exactamente la
 * que va a usar el que quiera saltear. Es el mismo argumento por el que la
 * barrera de entrada intercepta `registerTool` en vez de chequear tool por tool.
 *
 * Devuelve la clave OPACA del store, no el teléfono: el valor termina dentro del
 * hash de un token que viaja por el modelo (ver `confirm.ts`).
 *
 * SE EXPORTA porque hay una octava tool que emite y verifica un
 * `confirmation_token` sin pasar por `runWriteOperation`:
 * `biller_recordatorio_cobro`. No escribe un CFE —manda un WhatsApp— así que no
 * usa el runner, pero su token autoriza igual una acción irreversible de cara
 * al cliente. Sin esta identidad, dentro de una misma empresa el token que
 * previsualizó un número lo podía confirmar otro.
 *
 * TRES CASOS EN LOS QUE DA `null`, y los tres tienen que dar null:
 *  - sin Kapso configurado: no hay canal no confiable, y el modo escritorio
 *    valida igual que antes de este cambio;
 *  - config ilegible: convertir un problema de entorno en un rechazo de
 *    autorización manda a diagnosticar al lugar equivocado — y el error de
 *    configuración lo reporta igual el resto del runner, con mejor mensaje;
 *  - con Kapso pero SIN remitente: la barrera de entrada ya rechaza eso antes
 *    del handler, así que acá no se puede exigir sin romper la emisión directa
 *    (la que no viene de la guiada) en los tests y en cualquier caller propio.
 *    No abre nada: el ciclo sin remitente es consistente consigo mismo, pero un
 *    token emitido POR alguien sigue sin validar sin ese alguien.
 */
export function identidadDeEscritura(ctx: ToolContext, remitente: string | undefined): string | null {
  try {
    if (!requiereRemitente(ctx.getConfig())) return null;
    const verificado = normalizarTelefono(remitente ?? "");
    if (verificado === "") return null;
    return ctx.getBorradorStore().clave(verificado);
  } catch {
    return null;
  }
}

/**
 * Deriva una `idempotency_key` estable del `confirmation_token`.
 *
 * Se hashea en vez de usar el token tal cual porque la clave viaja al audit log
 * y al registro persistente, y el token es la credencial que autoriza ejecutar:
 * no tiene por qué quedar escrita en dos archivos más.
 */
function claveDesdeToken(token: string | undefined): string {
  if (token === undefined || token.trim() === "") return generateIdempotencyKey();
  return createHash("sha256").update(`idem:${token}`).digest("hex").slice(0, 32);
}

export async function runWriteOperation(p: RunWriteParams): Promise<ToolResult> {
  const { ctx, tool, endpoint } = p;
  const warnings = [...(p.warnings ?? [])];

  // LAS MARCAS DE LA BARRERA DE SALIDA NO ENTRAN A UN DOCUMENTO FISCAL.
  //
  // El modelo lee un `payload_preview` —o el `ejemplo` de
  // `biller_requisitos_comprobante`, que sale envuelto por tener una clave
  // `concepto`— y copia el string con las marcas adentro. Sin esto, el CFE salía
  // ante DGI con "⟦dato-no-confiable⟧ Bolsa de portland ⟦/dato-no-confiable⟧"
  // impreso en la línea, y no había ninguna advertencia en ningún lado.
  //
  // VA ACÁ Y ANTES DEL TOKEN, no en cada tool, por dos razones. Es la única
  // costura por la que pasan las SIETE tools de escritura, así que una tool
  // nueva queda cubierta sin que nadie se acuerde. Y el `confirmation_token`
  // hashea el payload: si se limpiara después, el dry-run hashearía el sucio y
  // el confirm el limpio, y el usuario recibiría "el payload cambió" —el aviso
  // que existe para detectar manipulación— por un cambio que hicimos nosotros.
  const { valor: payload, limpiados } = limpiarMarcasProfundo(p.payload);
  if (limpiados.length > 0) {
    warnings.push(
      `Se limpiaron marcas de la barrera de datos en: ${limpiados.join(", ")}. El texto se emite sin ` +
        "las marcas. Si esto se repite, el modelo está copiando valores de una respuesta anterior en " +
        "vez de tomarlos del borrador.",
    );
  }

  try {
    const config = ctx.getConfig();
    const environment = config.environment;
    const gate = evaluateWriteGate(config, { allowProduction: p.allowProduction });
    // El token (y la idempotencia/audit) ligan tanto el body como la query.
    const subject = { payload, query: p.query ?? null };
    const identidad = identidadDeEscritura(ctx, p.remitente);
    const token = computeConfirmationToken(endpoint, environment, subject, Date.now(), identidad);

    // --- Fase DRY-RUN ---
    if (!p.confirm) {
      if (!gate.allowed) {
        warnings.push(
          gate.reason === "write_disabled"
            ? "La ejecución está deshabilitada (BILLER_WRITE_ENABLED!=true). Este preview no ejecuta nada."
            : "La ejecución contra PRODUCCIÓN está bloqueada. Requiere BILLER_ALLOW_PRODUCTION_WRITES=true y allow_production=true.",
        );
      }
      if (environment === "production") {
        warnings.push(
          "⚠️ Ambiente PRODUCCIÓN: ejecutar este POST emite/anula un comprobante REAL ante DGI.",
        );
      }
      if (p.idempotencyKey !== undefined) {
        warnings.push(
          "La protección de idempotencia es in-process y se resetea al reiniciar el servidor MCP.",
        );
      }
      // El tope se APLICA en `executeWrite`, o sea con confirm=true. Acá se
      // ANTICIPA: un preview que no dice nada y una confirmación que rebota es
      // exactamente el momento en que la gente vuelve a intentar sin entender.
      try {
        verificarLimiteMonto(payload, config.maxMontos, p.montoExplicito);
      } catch (err) {
        warnings.push(
          `⛔ ${err instanceof Error ? err.message : String(err)} ` +
            "Este preview es válido, pero confirmarlo va a rebotar.",
        );
      }
      return jsonResult({
        mode: "dry_run",
        tool,
        endpoint,
        environment,
        method: "POST",
        write_enabled: config.writeEnabled,
        gate: {
          allowed: gate.allowed,
          reason: gate.reason ?? null,
          requires_allow_production: environment === "production",
        },
        payload_preview: maskPayloadPreview(payload),
        query_preview: p.query ?? null,
        confirmation_token: token,
        idempotency_key: p.idempotencyKey ?? null,
        next_step:
          `Para EJECUTAR, volvé a llamar ${tool} con confirm=true y confirmation_token="${token}"` +
          (environment === "production" ? " y allow_production=true." : ".") +
          " Los documentos y contactos están parcialmente enmascarados en este preview.",
        no_network_call: true,
        ...(p.totalesEstimados !== undefined
          ? {
              totales_estimados: p.totalesEstimados,
              resumen: formatearTotales(p.totalesEstimados, p.contextoPreview ?? {}),
            }
          : {}),
        warnings,
      });
    }

    // --- Fase EJECUCIÓN ---
    // El chequeo distingue el motivo: "vencido" se arregla repitiendo el
    // dry-run, "no coincide" significa que el payload cambió. Devolver el mismo
    // mensaje para los dos hace que el modelo reintente lo que no debe.
    const check = checkConfirmationToken(p.confirmationToken, endpoint, environment, subject, {
      identidad,
    });
    if (!check.ok) {
      // El token de otra conversación no es un problema de confirmación sino de
      // autorización, y sale con la misma forma que los otros rechazos de sesión
      // ajena (`motivo: "sesion_ajena"`) para que el modelo lo reconozca como lo
      // que es: algo que no se reintenta.
      if (check.motivo === "sesion_ajena") return rechazoSesionAjena(check.mensaje, ctx);
      throw new BillerConfirmationError(check.mensaje);
    }

    // LA CLAVE SALE DEL TOKEN, NO DE UN AZAR NUEVO EN CADA INTENTO.
    //
    // `generateIdempotencyKey()` es un UUID random. Si el agente no manda
    // `idempotency_key` —y no tiene por qué acordarse—, cada `confirm` traía una
    // clave distinta, así que el registro de idempotencia no reconocía el
    // reintento y la escritura pasaba de nuevo. O sea que el mismo
    // `confirmation_token`, reenviado por un timeout de Kapso o por un
    // reintento del modelo, EMITÍA DOS VECES el mismo CFE ante DGI. Y dos CFE
    // no se deshacen: se anulan con dos notas de crédito.
    //
    // El token ya identifica unívocamente esta operación —hashea endpoint,
    // ambiente, payload y el instante del dry-run—, así que derivar la clave de
    // él hace que dos confirmaciones del MISMO preview compartan clave y la
    // segunda choque con `idempotency.has()`. Dos dry-runs distintos dan tokens
    // distintos y siguen pudiendo emitir dos veces: eso es el usuario haciendo
    // la operación dos veces a propósito, que es otra cosa.
    //
    // Una `idempotency_key` explícita le sigue ganando: quien la manda sabe algo
    // que nosotros no sobre qué reintento es cuál.
    const idempotencyKey = p.idempotencyKey ?? claveDesdeToken(p.confirmationToken);
    const result = await executeWrite(ctx.getWriteContext(), {
      tool,
      endpoint,
      payload,
      query: p.query,
      idempotencyKey,
      allowProduction: p.allowProduction,
      rateLimitClass: p.rateLimitClass,
      remitente: p.remitente,
      ...(p.montoExplicito !== undefined ? { montoExplicito: p.montoExplicito } : {}),
    });

    return jsonResult({
      mode: "executed",
      tool,
      endpoint,
      environment,
      http_status: result.status,
      idempotency_key: result.idempotency_key,
      response: result.data,
      audit_id: result.audit.audit_id,
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}
