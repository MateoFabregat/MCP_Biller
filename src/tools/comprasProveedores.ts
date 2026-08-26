// =============================================================================
// biller_compras_proveedores
//
// A quién le compro, cuánto, y cuánto IVA crédito y retenciones generan esas
// compras. Sobre GET /v2/comprobantes/recibidos/obtener.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PERIODOS_SOPORTADOS } from "../services/periodo.js";
import { rankingProveedores } from "../services/proveedores.js";
import { resolverRango, traerVentanaRecibidos } from "../services/ventana.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  fechaSchema,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  periodo: z
    .string()
    .optional()
    .default("ultimos_90_dias")
    .describe(`Período por fecha del comprobante. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}.`),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  moneda: z.string().optional().describe("Moneda para ordenar. Default: la de mayor volumen."),
  limite: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(20)
    .describe("Cuántos proveedores devolver, del que más factura al que menos."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7)."),
};

export const comprasProveedoresInputSchema = z.object(inputShape);

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string() }),
  fuente: z.literal("biller:/v2/comprobantes/recibidos/obtener"),
  proveedores: z.array(
    z.object({
      rut_emisor: z.string().nullable(),
      nombre: z.string().nullable(),
      total_por_moneda: z.record(z.number()),
      iva_por_moneda: z.record(z.number()),
      neto_por_moneda: z.record(z.number()),
      retenido_por_moneda: z.record(z.number()),
      comprobantes: z.number(),
      primera_compra: z.string().nullable(),
      ultima_compra: z.string().nullable(),
      participacion_pct: z.number().nullable(),
    }),
  ),
  moneda_orden: z.string(),
  monedas_presentes: z.array(z.string()),
  total_por_moneda: z.record(z.number()),
  iva_credito_por_moneda: z.record(z.number()),
  retenciones_por_moneda: z.record(z.number()),
  proveedores_totales: z.number(),
  comprobantes_analizados: z.number(),
  concentracion_top_3_pct: z.number().nullable(),
  ventanas_consultadas: z.number(),
  es_devengado_no_pagado: z.literal(true),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handleComprasProveedores(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = comprasProveedoresInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const resuelto = resolverRango({ periodo: a.periodo, desde: a.desde, hasta: a.hasta });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rango = resuelto.rango;

  try {
    const recibidos = await traerVentanaRecibidos(ctx, rango, {
      ventana_dias: a.ventana_dias,
    });
    const resultado = rankingProveedores(recibidos.comprobantes, {
      moneda: a.moneda,
      limite: a.limite,
    });

    return jsonResult({
      periodo: rango,
      fuente: "biller:/v2/comprobantes/recibidos/obtener",
      proveedores: resultado.proveedores,
      moneda_orden: resultado.moneda_orden,
      monedas_presentes: resultado.monedas_presentes,
      total_por_moneda: resultado.total_por_moneda,
      iva_credito_por_moneda: resultado.iva_credito_por_moneda,
      retenciones_por_moneda: resultado.retenciones_por_moneda,
      proveedores_totales: resultado.proveedores_totales,
      comprobantes_analizados: resultado.comprobantes_analizados,
      concentracion_top_3_pct: resultado.concentracion_top_3_pct,
      ventanas_consultadas: recibidos.ventanas,
      es_devengado_no_pagado: true,
      no_convertir_moneda: true,
      warnings: [...recibidos.warnings, ...resultado.warnings],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerComprasProveedores(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_compras_proveedores",
    {
      title: "Compras por proveedor",
      description:
        "A quién le comprás y cuánto, sobre los comprobantes que tus proveedores te emitieron y DGI " +
        "puso a disposición. Incluye el IVA crédito y las retenciones que generan esas compras, y la " +
        "concentración del top 3. IMPORTANTE: son montos DEVENGADOS (lo que te facturaron), no " +
        "pagados — Biller no expone tus pagos a proveedores, así que esto NO contesta cuánto les debés.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Compras por proveedor" },
    },
    async (args) => handleComprasProveedores(args, ctx),
  );
}
