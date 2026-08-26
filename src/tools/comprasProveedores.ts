// =============================================================================
// biller_compras_proveedores
//
// A quién le compro, cuánto, y cuánto IVA crédito y retenciones generan esas
// compras. Sobre GET /v2/comprobantes/recibidos/obtener.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchRecibidos } from "../biller/queries.js";
import type { ComprobanteRecibido } from "../biller/types.js";
import {
  PERIODOS_SOPORTADOS,
  partirEnVentanas,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
import { rankingProveedores } from "../services/proveedores.js";
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

/** Trae los recibidos del rango en ventanas, deduplicando por identidad fiscal. */
async function traerRecibidos(
  client: ReturnType<ToolContext["getClient"]>,
  rango: RangoFechas,
  ventanaDias: number | undefined,
): Promise<{ lista: ComprobanteRecibido[]; ventanas: number; warnings: string[] }> {
  const ventanas = partirEnVentanas(rango, ventanaDias);
  const warnings: string[] = [];
  const vistos = new Map<string, ComprobanteRecibido>();

  for (const v of ventanas) {
    const lote = await fetchRecibidos(client, { fecha_desde: v.desde, fecha_hasta: v.hasta });
    for (const r of lote) {
      // Los recibidos no traen `id`. La identidad fiscal de un CFE es
      // emisor+tipo+serie+número.
      const clave = `${r.rut_emisor ?? "?"}|${r.tipo ?? "?"}|${r.serie ?? "?"}|${r.numero ?? "?"}`;
      if (!vistos.has(clave)) vistos.set(clave, r);
    }
  }

  if (ventanas.length > 1) {
    warnings.push(
      `Los comprobantes recibidos se consultaron en ${ventanas.length} ventanas (la API los limita ` +
        "a 1 req/seg y falla con rangos amplios). Se deduplicaron por emisor+tipo+serie+número.",
    );
  }
  return { lista: [...vistos.values()], ventanas: ventanas.length, warnings };
}

export async function handleComprasProveedores(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = comprasProveedoresInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  let rango: RangoFechas;
  if (a.desde !== undefined && a.hasta !== undefined) {
    rango = { desde: a.desde, hasta: a.hasta };
  } else {
    const resuelto = resolverPeriodo(a.periodo);
    if (resuelto === null) {
      return simpleErrorResult(
        `No se pudo interpretar el período "${a.periodo}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
        ctx,
      );
    }
    rango = resuelto;
  }

  if (rango.desde > rango.hasta) {
    return simpleErrorResult(
      `El período está invertido: 'desde' (${rango.desde}) es posterior a 'hasta' (${rango.hasta}).`,
      ctx,
    );
  }

  try {
    const client = ctx.getClient();
    const recibidos = await traerRecibidos(client, rango, a.ventana_dias);
    const resultado = rankingProveedores(recibidos.lista, {
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
