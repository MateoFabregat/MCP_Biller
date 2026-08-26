// =============================================================================
// biller_cohortes_clientes (A10)
//
// Los clientes que entraron en marzo, ¿siguen comprando en julio? El total
// mensual nunca lo contesta: mezcla a los que están hace años con los que
// entraron ayer, y un mes plano puede ser "no perdí a nadie" o "perdí la mitad
// y los reemplacé con nuevos".
//
// El período por defecto es el AÑO ACTUAL, no los 90 días de las demás tools:
// una cohorte necesita varios meses para decir algo. Con 90 días lo único que
// se ve es el mes de alta.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { calcularCohortes } from "../services/cohortes.js";
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

const inputShape = {
  periodo: z
    .string()
    .optional()
    .default("anio_actual")
    .describe(
      `Período por fecha de EMISIÓN. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: anio_actual — una cohorte con dos meses de historia no dice nada.",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  moneda: z
    .string()
    .optional()
    .describe("Moneda de los importes por cohorte. Default: la de mayor facturación."),
  meses_de_gracia: z
    .number()
    .int()
    .min(0)
    .max(12)
    .optional()
    .default(1)
    .describe(
      "Cuántos meses iniciales marcar como contaminados y excluir de la curva promedio. El primero " +
        "SIEMPRE lo está: todo cliente preexistente que compra ahí parece un alta. Subilo si el " +
        "negocio tiene clientes que compran cada varios meses.",
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo comprobantes "Aceptado DGI" (criterio que usa Biller). Default: true.'),
  sucursal: z.string().optional().describe("Filtra a una sola sucursal (ID real de Biller)."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const cohortesClientesInputSchema = z.object(inputShape);

const celdaSchema = z.object({
  mes: z.string(),
  offset: z.number(),
  clientes_activos: z.number(),
  retencion_pct: z.number(),
  facturado: z.number(),
});

const cohorteSchema = z.object({
  mes_alta: z.string(),
  clientes: z.number(),
  facturado_total: z.number(),
  valor_por_cliente: z.number().nullable(),
  meses: z.array(celdaSchema),
  posible_contaminada: z.boolean(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  lectura: z.string(),
  cohortes: z.array(cohorteSchema),
  retencion_promedio: z.array(
    z.object({ offset: z.number(), retencion_pct: z.number(), cohortes: z.number() }),
  ),
  meses: z.array(z.string()),
  meses_de_gracia: z.number(),
  moneda_orden: z.string(),
  monedas_presentes: z.array(z.string()),
  clientes_totales: z.number(),
  comprobantes_analizados: z.number(),
  ventanas_consultadas: z.number(),
  alta_es_primera_compra_del_rango: z.literal(true),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handleCohortesClientes(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = cohortesClientesInputSchema.safeParse(args);
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
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const consulta = await consultarPorPeriodo(client, rango, {
      sucursal,
      ventanaDias: a.ventana_dias,
    });
    const filtrado = filterEmitidos(consulta.comprobantes, {
      emitidas_desde: rango.desde,
      emitidas_hasta: rango.hasta,
    });

    const resultado = calcularCohortes(filtrado.list, rango, {
      solo_aceptados: a.solo_aceptados,
      moneda: a.moneda,
      meses_de_gracia: a.meses_de_gracia,
    });

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      fuente: "biller:/v2/comprobantes/obtener",
      lectura: resultado.lectura,
      cohortes: resultado.cohortes,
      retencion_promedio: resultado.retencion_promedio,
      meses: resultado.meses,
      meses_de_gracia: resultado.meses_de_gracia,
      moneda_orden: resultado.moneda_orden,
      monedas_presentes: resultado.monedas_presentes,
      clientes_totales: resultado.clientes_totales,
      comprobantes_analizados: resultado.comprobantes_analizados,
      ventanas_consultadas: consulta.ventanas,
      // Bandera explícita, no decorativa: es la limitación que hace que el
      // primer mes esté inflado, y viaja en la respuesta para que el modelo no
      // la pierda entre los warnings.
      alta_es_primera_compra_del_rango: true,
      no_convertir_moneda: true,
      warnings: [...consulta.warnings, ...filtrado.warnings, ...resultado.warnings],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerCohortesClientes(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_cohortes_clientes",
    {
      title: "Cohortes de clientes",
      description:
        "Agrupa a los clientes por el mes de su primera compra y sigue a cada grupo mes a mes: " +
        "cuántos volvieron (retención) y cuánto facturaron. Es lo que el total mensual no muestra — " +
        "un mes plano puede ser 'no perdí a nadie' o 'perdí la mitad y los reemplacé'. OJO: el alta " +
        "es la primera compra DENTRO DEL RANGO (Biller no expone fecha de alta), así que las " +
        "primeras cohortes vienen infladas con clientes viejos y se marcan 'posible_contaminada'.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Cohortes de clientes" },
    },
    async (args) => handleCohortesClientes(args, ctx),
  );
}
