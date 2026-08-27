// =============================================================================
// biller_comparar_periodos
//
// "¿Vendí más que el mes pasado?", "¿en cuánto cierro el mes?" y "¿cuánto me
// pega el dólar?" en una sola consulta. Resuelve el período anterior
// automáticamente para que el usuario no tenga que calcularlo.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METODOS_PROYECCION, compararPeriodos } from "../services/comparacion.js";
import {
  PERIODOS_SOPORTADOS,
  periodoAnterior,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
import { resolverRango, traerVentana } from "../services/ventana.js";
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
      `Período a analizar (por fecha de EMISIÓN). Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: mes_actual. El período de comparación se calcula solo.",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  comparar_con: z
    .string()
    .optional()
    .describe(
      "Período contra el cual comparar. Si se omite, el inmediatamente anterior del mismo largo. " +
        'Para año contra año usá el mismo mes del año pasado (ej. "2025-07").',
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo comprobantes "Aceptado DGI". Default: true.'),
  sucursal: z.string().optional().describe("Filtra a una sola sucursal (ID real de Biller)."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const compararPeriodosInputSchema = z.object(inputShape);

const totalesPeriodoSchema = z.object({
  rango: z.object({ desde: z.string(), hasta: z.string() }),
  total_por_moneda: z.record(z.number()),
  comprobantes: z.number(),
});

const outputShape = {
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  criterio: z.literal("fecha_emision"),
  lectura: z.string(),
  actual: totalesPeriodoSchema,
  anterior: totalesPeriodoSchema,
  variaciones: z.array(
    z.object({
      moneda: z.string(),
      actual: z.number(),
      anterior: z.number(),
      absoluta: z.number(),
      porcentual: z.number().nullable(),
      lectura: z.string(),
    }),
  ),
  proyeccion: z
    .object({
      moneda: z.string(),
      facturado_hasta_ahora: z.number(),
      dias_transcurridos: z.number(),
      dias_del_periodo: z.number(),
      promedio_diario: z.number(),
      proyectado_al_cierre: z.number(),
      variacion_proyectada_pct: z.number().nullable(),
      metodo: z.enum(METODOS_PROYECCION),
      advertencia: z.string(),
    })
    .nullable(),
  exposicion_cambiaria: z.array(
    z.object({
      moneda: z.string(),
      total_moneda_extranjera: z.number(),
      equivalente_local: z.number(),
      tasa_promedio_ponderada: z.number().nullable(),
      participacion_pct: z.number(),
      comprobantes: z.number(),
      sensibilidad: z.array(z.object({ variacion_pct: z.number(), impacto_local: z.number() })),
    }),
  ),
  moneda_principal: z.string().nullable(),
  ventanas_consultadas: z.number(),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handleCompararPeriodos(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = compararPeriodosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const resuelto = resolverRango({ periodo: a.periodo, desde: a.desde, hasta: a.hasta });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rangoActual = resuelto.rango;

  // `comparar_con` NO pasa por `resolverRango`: su mensaje de error nombra el
  // parámetro que el usuario escribió mal, y decirle "no se pudo interpretar el
  // período" cuando el período estaba bien manda a mirar el lugar equivocado.
  let rangoAnterior: RangoFechas;
  if (a.comparar_con !== undefined) {
    const comparado = resolverPeriodo(a.comparar_con);
    if (comparado === null) {
      return simpleErrorResult(
        `No se pudo interpretar comparar_con="${a.comparar_con}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
        ctx,
      );
    }
    rangoAnterior = comparado;
  } else {
    rangoAnterior = periodoAnterior(rangoActual);
  }

  try {
    const opts = { sucursal: a.sucursal, ventana_dias: a.ventana_dias };

    // Los dos períodos en paralelo. Desde que la partición está anclada a una
    // grilla global, cuando se solapan (p.ej. "ultimos_30" contra los 30
    // previos) la segunda consulta encuentra en memoria las ventanas comunes.
    const [actual, anterior] = await Promise.all([
      traerVentana(ctx, { ...opts, rango: rangoActual }),
      traerVentana(ctx, { ...opts, rango: rangoAnterior }),
    ]);

    const resultado = compararPeriodos(
      actual.comprobantes,
      anterior.comprobantes,
      rangoActual,
      rangoAnterior,
      { solo_aceptados: a.solo_aceptados },
    );

    return jsonResult({
      fuente: "biller:/v2/comprobantes/obtener",
      criterio: "fecha_emision",
      lectura: resultado.lectura,
      actual: resultado.actual,
      anterior: resultado.anterior,
      variaciones: resultado.variaciones,
      proyeccion: resultado.proyeccion,
      exposicion_cambiaria: resultado.exposicion_cambiaria,
      moneda_principal: resultado.moneda_principal,
      ventanas_consultadas: actual.ventanas + anterior.ventanas,
      no_convertir_moneda: true,
      warnings: [...actual.warnings, ...anterior.warnings, ...resultado.warnings],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerCompararPeriodos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_comparar_periodos",
    {
      title: "Comparar períodos y proyectar el cierre",
      description:
        "Compara la facturación de un período contra otro (por defecto el anterior del mismo largo), " +
        "proyecta el cierre si el período sigue abierto, y calcula la exposición cambiaria: cuánto " +
        "se factura en moneda extranjera y qué impacto tiene un movimiento de la cotización. " +
        "Las variaciones se calculan POR MONEDA, nunca sumando monedas distintas. La proyección es " +
        "un run-rate lineal y viaja con esa advertencia.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Comparar períodos y proyectar el cierre" },
    },
    async (args) => handleCompararPeriodos(args, ctx),
  );
}
