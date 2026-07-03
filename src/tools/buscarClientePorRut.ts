// =============================================================================
// biller_buscar_cliente_por_rut  (solicitado: buscar_cliente_por_rut)
//
// IMPORTANTE: consulta datos DGI por RUT/documento. NO confirma que el RUT sea
// un cliente registrado en Biller (no existe endpoint GET documentado para eso).
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PATHS } from "../constants.js";
import {
  normalizeDgiActividad,
  normalizeDgiCertificado,
  normalizeDgiDatosEntidad,
  normalizeDgiNombreEntidad,
} from "../biller/normalize.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const ADVERTENCIA =
  "La documentación pública de Biller no incluye un endpoint GET para validar clientes propios de Biller. " +
  "Estos datos provienen de DGI y NO confirman que el RUT sea un cliente registrado en Biller.";

const detalleSchema = z
  .enum(["nombre", "datos_entidad", "actividad", "certificado"])
  .default("datos_entidad")
  .describe(
    "Qué consulta DGI realizar: nombre-entidad, datos-entidad (default), actividad-empresarial o certificado-unico.",
  );

const inputShape = {
  rut: z
    .string()
    .trim()
    .min(1, "rut es requerido.")
    .describe("RUT o documento de la entidad/persona a consultar en DGI."),
  detalle: detalleSchema,
  tipoDocumento: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Solo para detalle='nombre'. Tipo de documento DGI; default 2 (RUT)."),
};

const outputShape = {
  rut_consultado: z.string(),
  fuente: z.literal("dgi"),
  detalle: z.enum(["nombre", "datos_entidad", "actividad", "certificado"]),
  endpoint: z.string(),
  tipo_documento: z.string().nullable(),
  es_cliente_biller_confirmado: z.null(),
  advertencia: z.string(),
  datos: z.unknown(),
};

type Detalle = "nombre" | "datos_entidad" | "actividad" | "certificado";

export async function handleBuscarClientePorRut(
  args: { rut: string; detalle?: Detalle; tipoDocumento?: string | number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const detalle: Detalle = args.detalle ?? "datos_entidad";
  const rut = args.rut.trim();

  try {
    const client = ctx.getClient();
    let endpoint: string;
    let datos: unknown;
    let tipoDocumento: string | null = null;

    switch (detalle) {
      case "nombre": {
        endpoint = PATHS.dgiNombreEntidad;
        tipoDocumento = args.tipoDocumento !== undefined ? String(args.tipoDocumento) : "2";
        const raw = await client.get({
          path: endpoint,
          query: { documento: rut, tipoDocumento },
          rateLimitClass: "dgi",
        });
        datos = normalizeDgiNombreEntidad(raw);
        break;
      }
      case "actividad": {
        endpoint = PATHS.dgiActividad;
        const raw = await client.get({ path: endpoint, query: { rut }, rateLimitClass: "dgi" });
        datos = normalizeDgiActividad(raw);
        break;
      }
      case "certificado": {
        endpoint = PATHS.dgiCertificado;
        const raw = await client.get({ path: endpoint, query: { rut }, rateLimitClass: "dgi" });
        datos = normalizeDgiCertificado(raw);
        break;
      }
      case "datos_entidad":
      default: {
        endpoint = PATHS.dgiDatosEntidad;
        const raw = await client.get({ path: endpoint, query: { rut }, rateLimitClass: "dgi" });
        datos = normalizeDgiDatosEntidad(raw);
        break;
      }
    }

    return jsonResult({
      rut_consultado: rut,
      fuente: "dgi",
      detalle,
      endpoint,
      tipo_documento: tipoDocumento,
      es_cliente_biller_confirmado: null,
      advertencia: ADVERTENCIA,
      datos,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerBuscarClientePorRut(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_buscar_cliente_por_rut",
    {
      title: "Buscar datos de entidad por RUT (DGI)",
      description:
        "Consulta datos públicos de DGI por RUT/documento (razón social, datos de entidad, actividad o certificado único). " +
        "NO confirma que el RUT sea un cliente registrado en Biller: la API pública de Biller no expone un endpoint GET de clientes.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Buscar entidad por RUT (DGI)" },
    },
    async (args) => handleBuscarClientePorRut(args, ctx),
  );
}
