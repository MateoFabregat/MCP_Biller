// =============================================================================
// biller_anular_comprobante  -> POST /v2/comprobantes/anular  (ESCRITURA)
//
// Anula por `id` o por la terna `tipo_comprobante+serie+numero`. Requiere
// `fecha_emision_hoy` (0|1). Dos fases: dry-run y ejecución confirmada.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIPOS_COMPROBANTE } from "../../biller/cfeSchema.js";
import { booleano, codigo, entero } from "../../biller/coerce.js";
import { normalizarTelefono } from "../../config.js";
import { WRITE_PATHS } from "../../constants.js";
import { KapsoClient } from "../../kapso/client.js";
import {
  construirConfirmacionAnulacion,
  construirRevisionAnulacion,
} from "../../kapso/render.js";
import { checkConfirmationToken, computeConfirmationToken } from "../../write/confirm.js";
import {
  WRITE_ANNOTATIONS,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "../shared.js";
import {
  identidadDeEscritura,
  runWriteOperation,
  writeControlShape,
  writeOutputShape,
} from "./shared.js";

const ENDPOINT = WRITE_PATHS.comprobantesAnular;

// required: ["fecha_emision_hoy"]; `id` es obligatorio solo si no se envía la
// terna tipo_comprobante+serie+numero (y viceversa).
const inputShape = {
  id: entero("id").optional().describe("ID del CFE a anular. Obligatorio si no se envía la terna."),
  tipo_comprobante: codigo(TIPOS_COMPROBANTE, "tipo_comprobante")
    .optional()
    .describe("Con serie y numero, identifica el CFE. Obligatorio si no se envía 'id'."),
  serie: z.string().optional(),
  numero: entero("numero").optional(),
  sucursal: entero("sucursal")
    .optional()
    .describe("Sucursal emisora de la nota anuladora. Si se omite, se usa la del comprobante original."),
  fecha_emision_hoy: booleano().describe(
    "true: la nota de crédito se emite con fecha de hoy. false: con la fecha del comprobante anulado.",
  ),
  confirmar_por_whatsapp: z
    .string()
    .optional()
    .describe("En dry-run, envía la doble confirmación al número indicado."),
  confirmacion_revisada: z
    .boolean()
    .optional()
    .default(false)
    .describe("true después de tocar el paso 1; envía la confirmación final, todavía sin anular."),
  revision_token: z
    .string()
    .optional()
    .describe("Token no ejecutable recibido al tocar el paso 1 de la anulación."),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape).superRefine((d, ctx) => {
  const hasId = d.id !== undefined;
  const hasTrio = d.tipo_comprobante !== undefined && d.serie !== undefined && d.numero !== undefined;
  // La doc pide una u otra forma de identificación, pero no prohíbe enviar
  // ambas: solo se exige que haya al menos una completa.
  if (!hasId && !hasTrio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Identificá el comprobante con 'id' o con la terna completa tipo_comprobante+serie+numero.",
      path: ["id"],
    });
  }
  if (d.confirmacion_revisada && d.confirmar_por_whatsapp === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "confirmacion_revisada requiere confirmar_por_whatsapp.",
      path: ["confirmar_por_whatsapp"],
    });
  }
  if (d.confirmacion_revisada && !d.revision_token) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "La fase 2 requiere el revision_token recibido en la fase 1.",
      path: ["revision_token"],
    });
  }
});

export async function handleAnularComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: Record<string, unknown> = { fecha_emision_hoy: a.fecha_emision_hoy };
  if (a.id !== undefined) {
    payload.id = a.id;
  } else {
    payload.tipo_comprobante = a.tipo_comprobante;
    payload.serie = a.serie;
    payload.numero = a.numero;
  }
  if (a.sucursal !== undefined) payload.sucursal = a.sucursal;

  // El segundo mensaje solo puede derivar del PRIMER preview del mismo
  // comprobante y de la misma conversación. Así una alteración entre los dos
  // toques no cambia silenciosamente qué documento se anula.
  if (a.confirmacion_revisada) {
    const config = ctx.getConfig();
    const check = checkConfirmationToken(
      a.revision_token,
      `${ENDPOINT}:revision`,
      config.environment,
      { payload, query: null },
      { identidad: identidadDeEscritura(ctx, a.remitente) },
    );
    if (!check.ok) return simpleErrorResult(check.mensaje, ctx);
  }

  const resultado = await runWriteOperation({
    ctx,
    tool: "biller_anular_comprobante",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    remitente: a.remitente,
    rateLimitClass: "dgi",
    warnings: [
      "Anular genera una Nota de Crédito que anula el CFE en su totalidad. Solo funciona sobre " +
        "e-Tickets y e-Facturas que NO tengan comprobantes asociados.",
    ],
  });

  if (a.confirmar_por_whatsapp === undefined || resultado.isError === true) return resultado;
  return adjuntarDobleConfirmacion(resultado, {
    ctx,
    destinatario: a.confirmar_por_whatsapp,
    confirm: a.confirm,
    revisada: a.confirmacion_revisada,
    comprobante:
      a.id !== undefined
        ? `comprobante ID ${a.id}`
        : `${TIPOS_COMPROBANTE[a.tipo_comprobante!]} ${a.serie}-${a.numero}`,
    payload,
    remitente: a.remitente,
  });
}

async function adjuntarDobleConfirmacion(
  resultado: ToolResult,
  p: {
    ctx: ToolContext;
    destinatario: string;
    confirm: boolean;
    revisada: boolean;
    comprobante: string;
    payload: Record<string, unknown>;
    remitente?: string;
  },
): Promise<ToolResult> {
  const structured = resultado.structuredContent;
  if (structured === undefined) return resultado;
  const warnings = Array.isArray(structured["warnings"])
    ? (structured["warnings"] as string[])
    : [];
  const fallar = (motivo: string): ToolResult =>
    jsonResult({
      ...structured,
      confirmacion_whatsapp: { enviado: false, motivo },
      warnings: [...warnings, motivo],
    });

  if (p.confirm) {
    return fallar(
      "confirmar_por_whatsapp se ignoró: la anulación ya fue enviada a Biller con confirm=true.",
    );
  }
  const token = structured["confirmation_token"];
  if (typeof token !== "string") {
    return fallar("No se envió la confirmación: el dry-run no devolvió un token válido.");
  }

  try {
    const config = p.ctx.getConfig();
    if (config.kapso === undefined) {
      return fallar("No se envió la confirmación por WhatsApp: falta KAPSO_API_KEY.");
    }
    const destino = normalizarTelefono(p.destinatario);
    const revisionToken = computeConfirmationToken(
      `${ENDPOINT}:revision`,
      config.environment,
      { payload: p.payload, query: null },
      Date.now(),
      identidadDeEscritura(p.ctx, p.remitente),
    );
    const tokenDelBoton = p.revisada ? token : revisionToken;
    const mensaje = p.revisada
      ? construirConfirmacionAnulacion({
          comprobante: p.comprobante,
          ambiente: config.environment,
          token: tokenDelBoton,
        })
      : construirRevisionAnulacion({
          comprobante: p.comprobante,
          ambiente: config.environment,
          token: tokenDelBoton,
        });
    const envio = await new KapsoClient(config.kapso).enviarInteractivo(destino, mensaje);
    const {
      confirmation_token: _tokenEjecutable,
      next_step: _pasoEjecutable,
      ...sinTokenEjecutable
    } = structured;
    return jsonResult({
      ...(p.revisada ? structured : sinTokenEjecutable),
      ...(!p.revisada ? { revision_token: revisionToken } : {}),
      ...(!p.revisada
        ? { next_step: "Esperá el toque del paso 1 y recién entonces generá la confirmación final." }
        : {}),
      confirmacion_whatsapp: {
        enviado: true,
        fase: p.revisada ? 2 : 1,
        destinatario_sufijo: destino.slice(-4),
        message_id: envio.message_id,
        instruccion: p.revisada
          ? "Solo anules si vuelve anular:si:<token>; ese es el segundo toque."
          : "Si vuelve anular:revisar:<token>, pasalo como revision_token y mandá la fase 2. " +
            "Todavía no ejecutes el POST.",
      },
    });
  } catch {
    return fallar(
      "No se pudo enviar la confirmación por WhatsApp. El dry-run sigue siendo válido y no se anuló nada.",
    );
  }
}

export function registerAnularComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_anular_comprobante",
    {
      title: "Anular comprobante (CFE) — ESCRITURA",
      description:
        "ANULA un CFE existente ante DGI (POST /v2/comprobantes/anular). Por defecto dry-run; ejecuta con confirm=true + confirmation_token " +
        "y BILLER_WRITE_ENABLED=true (en producción también allow_production=true).",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Anular comprobante (escritura)" },
    },
    async (args) => handleAnularComprobante(args, ctx),
  );
}
