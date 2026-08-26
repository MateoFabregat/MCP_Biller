// =============================================================================
// biller_comparar_periodos
//
// "¿Vendí más que el mes pasado?", "¿en cuánto cierro el mes?" y "¿cuánto me
// pega el dólar?" en una sola consulta. Resuelve el período anterior
// automáticamente para que el usuario no tenga que calcularlo.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compararPeriodos } from "../services/comparacion.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import {
  PERIODOS_SOPORTADOS,
  consultarPorPeriodo,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
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

/** true si el rango es exactamente un mes calendario completo. */
function esMesCompleto(rango: RangoFechas): boolean {
  const d = new Date(`${rango.desde}T00:00:00Z`);
  const h = new Date(`${rango.hasta}T00:00:00Z`);
  if (d.getUTCDate() !== 1) return false;
  if (d.getUTCFullYear() !== h.getUTCFullYear() || d.getUTCMonth() !== h.getUTCMonth()) return false;
  const ultimoDia = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 1, 0)).getUTCDate();
  return h.getUTCDate() === ultimoDia;
}

/**
 * Período con el que se compara por defecto.
 *
 * DOS CASOS, porque "el período anterior" significa cosas distintas:
 *
 *  · MES CALENDARIO COMPLETO -> el mes calendario previo. Cuando alguien
 *    pregunta "¿vendí más que el mes pasado?" quiere junio contra julio, no
 *    "los 31 días anteriores al 1 de julio" (que arrancarían el 31 de mayo).
 *    Los meses tienen largos distintos y está bien: es la comparación que
 *    hace cualquier contador.
 *
 *  · CUALQUIER OTRO RANGO -> la ventana inmediatamente anterior del MISMO
 *    LARGO. Para "últimos 7 días" comparar contra los 7 previos es lo correcto;
 *    ahí sí, comparar largos distintos sería el error.
 */
export function periodoAnterior(rango: RangoFechas): RangoFechas {
  if (esMesCompleto(rango)) {
    const d = new Date(`${rango.desde}T00:00:00Z`);
    const anio = d.getUTCFullYear();
    const mes = d.getUTCMonth(); // 0-based; el previo es mes-1
    const inicio = new Date(Date.UTC(anio, mes - 1, 1));
    const fin = new Date(Date.UTC(anio, mes, 0)); // día 0 = último del mes previo
    return { desde: inicio.toISOString().slice(0, 10), hasta: fin.toISOString().slice(0, 10) };
  }

  const desde = Date.parse(`${rango.desde}T00:00:00Z`);
  const hasta = Date.parse(`${rango.hasta}T00:00:00Z`);
  const largoMs = hasta - desde + 86_400_000;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { desde: iso(desde - largoMs), hasta: iso(desde - 86_400_000) };
}

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
      metodo: z.literal("run_rate_lineal"),
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

  let rangoActual: RangoFechas;
  if (a.desde !== undefined && a.hasta !== undefined) {
    rangoActual = { desde: a.desde, hasta: a.hasta };
  } else {
    const resuelto = resolverPeriodo(a.periodo);
    if (resuelto === null) {
      return simpleErrorResult(
        `No se pudo interpretar el período "${a.periodo}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
        ctx,
      );
    }
    rangoActual = resuelto;
  }

  if (rangoActual.desde > rangoActual.hasta) {
    return simpleErrorResult(
      `El período está invertido: 'desde' (${rangoActual.desde}) es posterior a 'hasta' (${rangoActual.hasta}).`,
      ctx,
    );
  }

  let rangoAnterior: RangoFechas;
  if (a.comparar_con !== undefined) {
    const resuelto = resolverPeriodo(a.comparar_con);
    if (resuelto === null) {
      return simpleErrorResult(
        `No se pudo interpretar comparar_con="${a.comparar_con}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
        ctx,
      );
    }
    rangoAnterior = resuelto;
  } else {
    rangoAnterior = periodoAnterior(rangoActual);
  }

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;
    const opts = { sucursal, ventanaDias: a.ventana_dias };

    const [cActual, cAnterior] = await Promise.all([
      consultarPorPeriodo(client, rangoActual, opts),
      consultarPorPeriodo(client, rangoAnterior, opts),
    ]);

    const emitidosActual = filterEmitidos(cActual.comprobantes, {
      emitidas_desde: rangoActual.desde,
      emitidas_hasta: rangoActual.hasta,
    });
    const emitidosAnterior = filterEmitidos(cAnterior.comprobantes, {
      emitidas_desde: rangoAnterior.desde,
      emitidas_hasta: rangoAnterior.hasta,
    });

    const resultado = compararPeriodos(
      emitidosActual.list,
      emitidosAnterior.list,
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
      ventanas_consultadas: cActual.ventanas + cAnterior.ventanas,
      no_convertir_moneda: true,
      warnings: [
        ...cActual.warnings,
        ...cAnterior.warnings,
        ...emitidosActual.warnings,
        ...emitidosAnterior.warnings,
        ...resultado.warnings,
      ],
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
