// =============================================================================
// biller_ranking_sucursales (A8)
//
// Cuánto factura cada local, qué peso tiene sobre el total y —lo que decide
// algo— si ese peso subió o bajó contra el período anterior.
//
// NO acepta el parámetro `sucursal` que tienen las demás tools de lectura, y la
// omisión es deliberada: filtrar a una sola sucursal deja un ranking de un
// elemento con participación 100% y variación contra sí mismo. Por el mismo
// motivo IGNORA `BILLER_DEFAULT_SUCURSAL_ID` — si el default de la empresa
// filtrara acá, el ranking mostraría siempre un solo local y nadie entendería
// por qué faltan los otros dos.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import {
  PERIODOS_SOPORTADOS,
  consultarPorPeriodo,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
import { SALTO_PARTICIPACION_PP, rankingSucursales } from "../services/sucursales.js";
import { periodoAnterior } from "./compararPeriodos.js";
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
    .default("mes_actual")
    .describe(
      `Período por fecha de EMISIÓN. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. Default: mes_actual.`,
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  comparar_con: z
    .string()
    .optional()
    .describe(
      "Período contra el cual medir la evolución. Si se omite, el inmediatamente anterior del " +
        "mismo largo (o el mes calendario previo si el período es un mes completo).",
    ),
  comparar: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Traer también el período anterior para calcular la evolución. Ponelo en false si solo " +
        "querés la participación del período (cuesta la mitad de llamadas).",
    ),
  moneda: z
    .string()
    .optional()
    .describe("Moneda para ordenar y calcular participaciones. Default: la de mayor facturación."),
  salto_pp: z
    .number()
    .positive()
    .max(100)
    .optional()
    .default(SALTO_PARTICIPACION_PP)
    .describe(
      `Puntos porcentuales de participación a partir de los cuales el movimiento se marca como ` +
        `relevante. Default: ${SALTO_PARTICIPACION_PP}.`,
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo comprobantes "Aceptado DGI" (criterio que usa Biller). Default: true.'),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const rankingSucursalesInputSchema = z.object(inputShape);

const sucursalSchema = z.object({
  id: z.string().nullable(),
  nombre: z.string().nullable(),
  etiqueta: z.string(),
  facturado_por_moneda: z.record(z.number()),
  comprobantes: z.number(),
  clientes_distintos: z.number(),
  ticket_promedio: z.number().nullable(),
  participacion_pct: z.number().nullable(),
  facturado_anterior: z.number().nullable(),
  variacion_pct: z.number().nullable(),
  participacion_anterior_pct: z.number().nullable(),
  salto_participacion_pp: z.number().nullable(),
  lectura: z.string().nullable(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  periodo_comparado: z.object({ desde: z.string(), hasta: z.string() }).nullable(),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  sucursales: z.array(sucursalSchema),
  moneda_orden: z.string(),
  monedas_presentes: z.array(z.string()),
  total_facturado_por_moneda: z.record(z.number()),
  con_comparacion: z.boolean(),
  sucursales_totales: z.number(),
  comprobantes_analizados: z.number(),
  movimientos_relevantes: z.array(z.string()),
  ventanas_consultadas: z.number(),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handleRankingSucursales(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = rankingSucursalesInputSchema.safeParse(args);
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

  let rangoPrevio: RangoFechas | null = null;
  if (a.comparar) {
    if (a.comparar_con !== undefined) {
      const resuelto = resolverPeriodo(a.comparar_con);
      if (resuelto === null) {
        return simpleErrorResult(
          `No se pudo interpretar comparar_con="${a.comparar_con}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
          ctx,
        );
      }
      rangoPrevio = resuelto;
    } else {
      rangoPrevio = periodoAnterior(rango);
    }
  }

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    // Sin `sucursal`: ver el encabezado. Un ranking filtrado a un local no es un
    // ranking.
    const opts = { ventanaDias: a.ventana_dias };

    const [consulta, consultaPrevia] = await Promise.all([
      consultarPorPeriodo(client, rango, opts),
      rangoPrevio === null
        ? Promise.resolve(null)
        : consultarPorPeriodo(client, rangoPrevio, opts),
    ]);

    const filtrado = filterEmitidos(consulta.comprobantes, {
      emitidas_desde: rango.desde,
      emitidas_hasta: rango.hasta,
    });
    const filtradoPrevio =
      consultaPrevia === null || rangoPrevio === null
        ? null
        : filterEmitidos(consultaPrevia.comprobantes, {
            emitidas_desde: rangoPrevio.desde,
            emitidas_hasta: rangoPrevio.hasta,
          });

    const resultado = rankingSucursales(filtrado.list, filtradoPrevio?.list ?? null, {
      nombres: config.sucursales,
      moneda: a.moneda,
      solo_aceptados: a.solo_aceptados,
      salto_pp: a.salto_pp,
    });

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      periodo_comparado: rangoPrevio,
      fuente: "biller:/v2/comprobantes/obtener",
      sucursales: resultado.sucursales,
      moneda_orden: resultado.moneda_orden,
      monedas_presentes: resultado.monedas_presentes,
      total_facturado_por_moneda: resultado.total_facturado_por_moneda,
      con_comparacion: resultado.con_comparacion,
      sucursales_totales: resultado.sucursales_totales,
      comprobantes_analizados: resultado.comprobantes_analizados,
      movimientos_relevantes: resultado.movimientos_relevantes,
      ventanas_consultadas: consulta.ventanas + (consultaPrevia?.ventanas ?? 0),
      no_convertir_moneda: true,
      warnings: [
        ...consulta.warnings,
        ...(consultaPrevia?.warnings ?? []),
        ...filtrado.warnings,
        ...(filtradoPrevio?.warnings ?? []),
        ...resultado.warnings,
      ],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerRankingSucursales(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_ranking_sucursales",
    {
      title: "Ranking de sucursales",
      description:
        "Cuánto facturó cada sucursal, qué participación tiene sobre el total y cómo evolucionó " +
        "contra el período anterior — en importe y en PUNTOS de participación, que es lo que " +
        "muestra si un local está perdiendo terreno aunque facture más. Los nombres salen de " +
        "BILLER_SUCURSALES_JSON (Biller no expone endpoint de sucursales). Las notas de crédito " +
        "restan, los recibos no cuentan y NO se convierten monedas.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Ranking de sucursales" },
    },
    async (args) => handleRankingSucursales(args, ctx),
  );
}
