// =============================================================================
// biller_obtener_pdf  ->  GET /v2/comprobantes/pdf
//
// Devuelve la representación impresa del CFE. Biller responde el archivo
// codificado en base64.
//
// Decisión de diseño: por defecto NO se devuelve el base64.
// Un PDF típico son cientos de KB, que en base64 crecen ~33% más. Volcarlo en
// la respuesta de una tool inunda el contexto del modelo con datos que no puede
// interpretar. Por defecto se devuelven los metadatos (tamaño, hash, si es un
// PDF válido) y `incluir_base64: true` lo trae explícitamente cuando el llamador
// realmente lo necesita — por ejemplo para adjuntarlo a un WhatsApp.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { descargarPdf } from "../services/pdf.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  id: z.number().int().positive().describe("ID del CFE en Biller."),
  template: z
    .enum(["generico", "ticket-generico"])
    .optional()
    .describe(
      "Formato de representación impresa. Si se omite, Biller usa el definido en Ajustes → Representación impresa.",
    ),
  incluir_base64: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Default false. En true devuelve el PDF completo en base64 (puede ser muy grande). " +
        "Dejalo en false si solo querés verificar que el PDF existe.",
    ),
};

const inputSchema = z.object(inputShape);

const outputShape = {
  id: z.number(),
  template: z.string().nullable(),
  disponible: z.boolean(),
  es_pdf_valido: z.boolean(),
  bytes: z.number(),
  sha256: z.string(),
  base64: z.string().nullable(),
  warnings: z.array(z.string()),
};

export async function handleObtenerPdf(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const pdf = await descargarPdf(ctx.getClient(), { id: a.id, template: a.template });

    const warnings: string[] = [];
    if (!pdf.disponible) {
      return jsonResult({
        id: a.id,
        template: a.template ?? null,
        disponible: false,
        es_pdf_valido: false,
        bytes: 0,
        sha256: "",
        base64: null,
        warnings: [
          "Biller no devolvió contenido para ese comprobante. Verificá que el 'id' exista " +
            "(podés obtenerlo con biller_listar_comprobantes_emitidos).",
        ],
      });
    }

    if (!pdf.esPdfValido) {
      warnings.push(
        "El contenido devuelto no empieza con la firma de un PDF. Puede ser un mensaje de error " +
          "de Biller en vez del archivo.",
      );
    }

    if (!a.incluir_base64) {
      warnings.push(
        `El PDF pesa ${pdf.bytes} bytes y NO se incluyó en la respuesta. ` +
          "Volvé a llamar con incluir_base64=true si necesitás el archivo. " +
          "Para mandárselo a alguien por WhatsApp no hace falta traerlo acá: usá " +
          "biller_enviar_comprobante_whatsapp, que lo adjunta sin pasarlo por el contexto.",
      );
    } else if (pdf.bytes > 1_000_000) {
      warnings.push(
        `El PDF pesa ${pdf.bytes} bytes: el base64 incluido es grande y puede saturar el contexto.`,
      );
    }

    return jsonResult({
      id: a.id,
      template: a.template ?? null,
      disponible: true,
      es_pdf_valido: pdf.esPdfValido,
      bytes: pdf.bytes,
      sha256: pdf.sha256,
      base64: a.incluir_base64 ? pdf.base64 : null,
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerObtenerPdf(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_obtener_pdf",
    {
      title: "Obtener PDF de un comprobante",
      description:
        "Devuelve la representación impresa (PDF en base64) de un CFE vía GET /v2/comprobantes/pdf. " +
        "Por defecto solo devuelve metadatos (tamaño, hash, validez); pasá incluir_base64=true para " +
        "obtener el archivo. Admite template 'generico' o 'ticket-generico'.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Obtener PDF" },
    },
    async (args) => handleObtenerPdf(args, ctx),
  );
}
