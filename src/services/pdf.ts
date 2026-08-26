// =============================================================================
// Descarga de la representación impresa de un CFE.
//
// Vive en `services/` y no dentro de la tool porque hay dos consumidores con
// necesidades opuestas: `biller_obtener_pdf` quiere METADATOS (y por defecto
// NO el archivo, que satura el contexto del modelo), y
// `biller_enviar_comprobante_whatsapp` quiere los BYTES para adjuntarlos.
//
// Tener la descarga en un solo lugar evita que las dos difieran en lo que
// importa: qué cuenta como "un PDF de verdad" y qué se hace cuando Biller
// devuelve otra cosa.
// =============================================================================

import { createHash } from "node:crypto";
import type { BillerClient } from "../biller/client.js";
import { PATHS } from "../constants.js";

/** Un PDF siempre empieza con "%PDF-"; en base64 eso es "JVBERi". */
export const PREFIJO_PDF_BASE64 = "JVBERi";

export type PdfTemplate = "generico" | "ticket-generico";

export interface PdfDescargado {
  /** false cuando Biller no devolvió contenido para ese id. */
  disponible: boolean;
  /** El contenido tal cual vino. null si no hay. */
  base64: string | null;
  /** Los bytes decodificados. null si no hay contenido. */
  contenido: Buffer | null;
  bytes: number;
  sha256: string;
  /**
   * false si lo devuelto no empieza con la firma de un PDF. No se trata como
   * error: puede ser un mensaje de Biller, y el llamador decide si eso invalida
   * su caso de uso (adjuntarlo sí, mostrar metadatos no).
   */
  esPdfValido: boolean;
}

/**
 * GET /v2/comprobantes/pdf.
 *
 * La API devuelve el base64 como string plano; algunos entornos lo envuelven en
 * un objeto `{ pdf: "..." }`. Se aceptan las dos formas sin inventar una tercera.
 */
export async function descargarPdf(
  client: BillerClient,
  params: { id: number; template?: PdfTemplate },
): Promise<PdfDescargado> {
  const raw = await client.get<unknown>({
    path: PATHS.comprobantesPdf,
    query: { id: params.id, template: params.template },
    rateLimitClass: "default",
  });

  const base64 =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "object" && raw !== null && typeof (raw as { pdf?: unknown }).pdf === "string"
        ? (raw as { pdf: string }).pdf.trim()
        : null;

  if (base64 === null || base64.length === 0) {
    return {
      disponible: false,
      base64: null,
      contenido: null,
      bytes: 0,
      sha256: "",
      esPdfValido: false,
    };
  }

  const contenido = Buffer.from(base64, "base64");
  return {
    disponible: true,
    base64,
    contenido,
    bytes: contenido.byteLength,
    sha256: createHash("sha256").update(contenido).digest("hex"),
    esPdfValido: base64.startsWith(PREFIJO_PDF_BASE64),
  };
}
