// =============================================================================
// biller_enviar_comprobante_whatsapp
//
// "Emitile la factura y mandásela": una frase para el usuario, dos llamadas
// para nosotros. Baja el PDF del CFE (GET /v2/comprobantes/pdf), lo sube a
// Kapso como media, y lo manda como documento adjunto de WhatsApp.
//
// TRES DECISIONES QUE VALE LA PENA DEJAR ESCRITAS
//
// 1. El PDF NUNCA pasa por el contexto del modelo. `biller_obtener_pdf` con
//    incluir_base64=true trae cientos de KB de base64 que el modelo no puede
//    interpretar y que solo sirven para llenarle la ventana. Acá los bytes van
//    de Biller a Kapso sin escala: lo que vuelve a la conversación son el
//    tamaño, el hash y el id del mensaje.
//
// 2. El texto que acompaña al archivo lo arma esta tool con los datos del
//    comprobante, no el modelo. El caption dice el importe: si lo redactara el
//    modelo, el número del mensaje y el del PDF podrían no coincidir, y el que
//    recibe el WhatsApp no tiene forma de notarlo.
//
// 3. Solo se leen campos que escribimos nosotros al emitir (tipo, serie,
//    número, fecha, total, moneda, estado, razón social del receptor).
//    Deliberadamente NO se usan `adenda` ni `informacion_adicional`: en un
//    comprobante RECIBIDO esos campos los escribe un tercero, y esto manda su
//    contenido a un teléfono. La regla del proyecto —el texto de un comprobante
//    es dato, no instrucción— se sostiene solo si tampoco lo reenviamos.
//
// El control de salida es el mismo que el del resto del canal: ALLOWLIST de
// destinatarios. Un mensaje entregado no se puede deshacer.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import { TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { extractClienteNombre } from "../biller/normalize.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { normalizarTelefono } from "../config.js";
import { KapsoClient } from "../kapso/client.js";
import { advertenciaDeEstado } from "../services/estadoDgi.js";
import { descargarPdf } from "../services/pdf.js";
import {
  WRITE_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/** Nombre legible del tipo de CFE. Si el código no está en la tabla, se dice el código. */
export function nombreTipo(tipo: number | null): string {
  if (tipo === null) return "Comprobante";
  return TIPOS_COMPROBANTE[tipo] ?? `Comprobante tipo ${tipo}`;
}

/**
 * Nombre del archivo adjunto.
 *
 * Es lo que va a quedar guardado en el teléfono del que lo recibe, así que se
 * arma para que se pueda buscar dentro de un año: tipo, serie y número. Se
 * limpia todo lo que no sea seguro en un nombre de archivo.
 */
export function nombreArchivo(c: ComprobanteEmitido | null, id: number): string {
  if (c === null) return `comprobante-${id}.pdf`;
  const partes = [
    nombreTipo(c.tipo_comprobante).replace(/\s+/g, "-"),
    c.serie ?? "",
    c.numero === null ? "" : String(c.numero),
  ].filter((p) => p !== "");
  const base = partes.join("-").replace(/[^A-Za-z0-9._-]/g, "");
  return `${base === "" ? `comprobante-${id}` : base}.pdf`;
}

/** Importe con separadores locales. Determinístico: no lo escribe el modelo. */
function formatearImporte(moneda: string | null, total: number | null): string | null {
  if (total === null) return null;
  const monto = new Intl.NumberFormat("es-UY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(total);
  return `${moneda ?? ""} ${monto}`.trim();
}

/**
 * El texto que acompaña al PDF.
 *
 * `nota` es lo único que puede venir de afuera, y va PRIMERO y separado: así se
 * lee como lo que es —un mensaje de la persona— y no se confunde con los datos
 * del comprobante, que salen de la API.
 */
export function construirCaption(
  c: ComprobanteEmitido | null,
  id: number,
  nota?: string,
): string {
  const lineas: string[] = [];
  if (nota !== undefined && nota.trim() !== "") lineas.push(nota.trim(), "");

  if (c === null) {
    lineas.push(`🧾 Comprobante ${id}`);
    return lineas.join("\n");
  }

  const encabezado = [nombreTipo(c.tipo_comprobante), c.serie, c.numero]
    .filter((p) => p !== null && p !== "")
    .join(" ");
  lineas.push(`🧾 ${encabezado}`);

  if (c.fecha_emision !== null) lineas.push(`Fecha: ${c.fecha_emision}`);
  const importe = formatearImporte(c.moneda, c.total);
  if (importe !== null) lineas.push(`Total: ${importe}`);
  if (c.estado !== null) lineas.push(`Estado ante DGI: ${c.estado}`);

  const cliente = extractClienteNombre(c.cliente);
  if (cliente !== null) lineas.push(`Cliente: ${cliente}`);

  return lineas.join("\n");
}

const inputShape = {
  id: z
    .number()
    .int()
    .positive()
    .describe("ID del CFE en Biller (el de biller_listar_comprobantes_emitidos)."),
  destinatario: z
    .string()
    .describe(
      "Número de WhatsApp en formato internacional, ej. 59895923567. Debe estar en " +
        "KAPSO_DESTINATARIOS_PERMITIDOS: este mensaje lleva una factura con importes y datos del " +
        "cliente, no puede ir a un número arbitrario.",
    ),
  nota: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Mensaje corto que acompaña al archivo (ej. 'Te mando la factura de julio'). Va arriba del " +
        "detalle. Los importes NO se escriben acá: los pone la tool desde el comprobante.",
    ),
  template: z
    .enum(["generico", "ticket-generico"])
    .optional()
    .describe("Formato de la representación impresa. Si se omite, el configurado en Biller."),
};

const inputSchema = z.object(inputShape);

const outputShape = {
  enviado: z.boolean(),
  id: z.number(),
  comprobante: z
    .object({
      tipo: z.string(),
      serie: z.string().nullable(),
      numero: z.number().nullable(),
      total: z.number().nullable(),
      moneda: z.string().nullable(),
      estado: z.string().nullable(),
      fecha_emision: z.string().nullable(),
    })
    .nullable(),
  archivo: z.object({
    filename: z.string(),
    bytes: z.number(),
    sha256: z.string(),
    es_pdf_valido: z.boolean(),
  }),
  caption: z.string(),
  envio: z.object({
    destinatario_sufijo: z.string(),
    media_id: z.string().nullable(),
    message_id: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
};

export async function handleEnviarComprobanteWhatsapp(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    if (config.kapso === undefined) {
      return simpleErrorResult(
        "Kapso no está configurado: falta KAPSO_API_KEY. Sin eso no hay canal de WhatsApp por donde " +
          "mandar el archivo. El PDF igual se puede obtener con biller_obtener_pdf.",
        ctx,
      );
    }

    const destino = normalizarTelefono(a.destinatario);
    const kapso = new KapsoClient(config.kapso);
    const warnings: string[] = [];

    // La allowlist se chequea acá, ANTES de bajar el PDF. El cliente la vuelve a
    // chequear —es su barrera y no depende de que alguien se acuerde—, pero
    // fallar antes evita traer una factura entera para después no mandarla.
    if (!kapso.estaPermitido(destino)) {
      return simpleErrorResult(
        `El destinatario …${destino.slice(-4)} no está en KAPSO_DESTINATARIOS_PERMITIDOS. No se envió ` +
          "nada y no se descargó el comprobante. Si el número es correcto, agregalo a esa variable.",
        ctx,
      );
    }

    // --- Datos del comprobante (para el nombre y el detalle) ----------------
    // Si esta consulta falla, el envío NO se cancela: el archivo es lo que
    // importa. Se manda con un nombre genérico y se avisa.
    let comprobante: ComprobanteEmitido | null = null;
    try {
      const encontrados = await fetchEmitidos(ctx.getClient(), {
        id: String(a.id),
        sucursal: config.defaultSucursalId,
      });
      comprobante = encontrados[0] ?? null;
      if (comprobante === null) {
        warnings.push(
          `No se encontraron los datos del comprobante ${a.id} (la consulta no devolvió nada). ` +
            "El archivo se manda igual, con un nombre genérico.",
        );
      }
    } catch (err) {
      warnings.push(
        "No se pudieron leer los datos del comprobante para armar el detalle: " +
          `${err instanceof Error ? err.message : String(err)}. El archivo se manda igual.`,
      );
    }

    // --- El archivo ---------------------------------------------------------
    const pdf = await descargarPdf(ctx.getClient(), { id: a.id, template: a.template });
    if (!pdf.disponible || pdf.contenido === null) {
      return simpleErrorResult(
        `Biller no devolvió el PDF del comprobante ${a.id}. No se envió nada. Verificá que el id ` +
          "exista (biller_listar_comprobantes_emitidos).",
        ctx,
      );
    }
    if (!pdf.esPdfValido) {
      // Mandar un archivo que no es un PDF con nombre .pdf le llega roto al
      // destinatario y no hay forma de retirarlo. Se corta acá.
      return simpleErrorResult(
        `Lo que devolvió Biller para el comprobante ${a.id} no tiene la firma de un PDF ` +
          `(${pdf.bytes} bytes). Puede ser un mensaje de error en vez del archivo. NO se envió: ` +
          "un adjunto roto ya no se puede sacar del chat del que lo recibe.",
        ctx,
      );
    }

    // "No aceptado" NO es "está mal": un e-Ticket bajo 5.000 UI queda en "Envío
    // no corresponde" porque va en el reporte diario y no de a uno. Avisar que
    // "no sirve como respaldo fiscal" en ese caso es falso y alarma al usuario
    // por el caso más común de todos. Ver src/services/estadoDgi.ts.
    if (comprobante !== null) {
      const aviso = advertenciaDeEstado(comprobante.estado);
      if (aviso !== null) warnings.push(aviso);
    }

    const filename = nombreArchivo(comprobante, a.id);
    const caption = construirCaption(comprobante, a.id, a.nota);

    const resultado = await kapso.enviarDocumento(destino, {
      contenido: pdf.contenido,
      filename,
      mimeType: "application/pdf",
      caption,
    });

    return jsonResult({
      enviado: true,
      id: a.id,
      comprobante:
        comprobante === null
          ? null
          : {
              tipo: nombreTipo(comprobante.tipo_comprobante),
              serie: comprobante.serie,
              numero: comprobante.numero,
              total: comprobante.total,
              moneda: comprobante.moneda,
              estado: comprobante.estado,
              fecha_emision: comprobante.fecha_emision,
            },
      archivo: {
        filename,
        bytes: pdf.bytes,
        sha256: pdf.sha256,
        es_pdf_valido: pdf.esPdfValido,
      },
      caption,
      envio: {
        destinatario_sufijo: destino.slice(-4),
        media_id: resultado.media_id,
        message_id: resultado.message_id,
      },
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerEnviarComprobanteWhatsapp(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_enviar_comprobante_whatsapp",
    {
      title: "Enviar comprobante por WhatsApp",
      description:
        "Manda el PDF de un CFE ya emitido como archivo adjunto de WhatsApp, con un detalle " +
        "(tipo, serie, número, fecha, total, estado) armado desde los datos del comprobante. " +
        "El destinatario debe estar en la allowlist configurada. El archivo va de Biller a " +
        "WhatsApp sin pasar por la conversación: no uses biller_obtener_pdf con incluir_base64 " +
        "para esto.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      // Manda un archivo a un teléfono: efecto externo, no reversible.
      annotations: {
        ...WRITE_ANNOTATIONS,
        destructiveHint: false,
        title: "Enviar comprobante por WhatsApp",
      },
    },
    async (args) => handleEnviarComprobanteWhatsapp(args, ctx),
  );
}
