// =============================================================================
// biller_resumen_facturacion_periodo
//
// Totales de facturación de un período, con cortes opcionales por sucursal,
// día, mes, tipo, moneda o cliente ("¿cuánto vendí en cada local en junio?").
//
// Dos decisiones que hacen que los números coincidan con Biller:
//   1. `periodo` se interpreta como fecha de EMISIÓN fiscal. La API solo filtra
//      por fecha de creación, así que se consulta con margen y se filtra local.
//   2. `solo_aceptados` viene en true: el total cuenta solo "Aceptado DGI".
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PERIODOS_SOPORTADOS } from "../services/periodo.js";
import { DIMENSIONES, resumirFacturacion, type Dimension } from "../services/resumenFacturacion.js";
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
    .describe(
      `Período por fecha de EMISIÓN fiscal. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Alternativa a desde/hasta; si se usa, tiene prioridad.",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd), por fecha de EMISIÓN. Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive, por fecha de EMISIÓN."),
  agrupar_por: z
    .array(z.enum(DIMENSIONES as [Dimension, ...Dimension[]]))
    .optional()
    .describe(
      "Cortes del total. Ej: [\"sucursal\"] responde \"cuánto vendí en cada lugar\"; " +
        "[\"sucursal\",\"mes\"] cruza local por mes.",
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true: cuenta solo comprobantes en estado 'Aceptado DGI', que es el criterio con el " +
        "que Biller muestra sus totales. En false suma todos los estados (el número no va a coincidir con Biller).",
    ),
  sucursal: z.string().optional().describe("Filtra la consulta a una sola sucursal (ID real de Biller)."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda antes de agregar."),
  cliente_rut: z.string().optional().describe("Filtro LOCAL por RUT de cliente (solo si es extraíble)."),
  incluir_anulados: z.boolean().optional().default(false).describe("Default false."),
  incluir_comprobantes: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Devuelve la lista de los comprobantes que forman el total, con el aporte de cada uno y su " +
        "`id` (para pedir el detalle con biller_obtener_comprobante o el PDF con biller_obtener_pdf). " +
        "Es la respuesta a \"mostrame esas facturas\".",
    ),
  limite_comprobantes: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(200)
    .describe("Tope de filas del detalle (default 200). Los TOTALES siempre se calculan sobre todos."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const resumenInputSchema = z.object(inputShape);

const monedaTotalSchema = z.object({ total: z.number(), comprobantes: z.number() });
const tipoTotalSchema = z.object({
  tipo: z.number(),
  categoria: z.enum(["venta", "nota_credito", "nota_debito", "especial", "desconocido"]),
  etiqueta: z.string(),
  signo: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  total_por_moneda: z.record(z.number()),
  conteo: z.number(),
});
const grupoSchema = z.object({
  clave: z.record(z.string()),
  etiqueta: z.string(),
  totales_por_moneda: z.record(monedaTotalSchema),
  conteo: z.number(),
});

const equivalenteUyuSchema = z.object({
  moneda_base: z.literal("UYU"),
  total_uyu: z.number(),
  completo: z.boolean(),
  comprobantes_convertidos: z.number(),
  comprobantes_sin_tasa: z.number(),
  cobertura_pct: z.number(),
  por_moneda: z.record(
    z.object({
      moneda: z.string(),
      total_original: z.number(),
      total_uyu: z.number(),
      comprobantes: z.number(),
      sin_tasa: z.number(),
      tasa_promedio_ponderada: z.number().nullable(),
      tasa_minima: z.number().nullable(),
      tasa_maxima: z.number().nullable(),
    }),
  ),
  metodo: z.string(),
  warnings: z.array(z.string()),
});

const comprobanteDelTotalSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  etiqueta_tipo: z.string(),
  categoria: z.string(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  fecha_emision: z.string().nullable(),
  estado: z.string().nullable(),
  moneda: z.string(),
  total: z.number(),
  aporte: z.number(),
  tasa_cambio: z.number().nullable(),
  aporte_uyu: z.number().nullable(),
  cliente_rut: z.string().nullable(),
  cliente_nombre: z.string().nullable(),
  sucursal: z.number().nullable(),
});

const outputShape = {
  periodo: z.object({
    desde: z.string(),
    hasta: z.string(),
    criterio: z.literal("fecha_emision"),
  }),
  rango_consultado_por_creacion: z.object({ desde: z.string(), hasta: z.string() }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  filtros_aplicados: z.record(z.unknown()),
  totales_por_moneda: z.record(monedaTotalSchema),
  /**
   * Todo lo facturado sumado en pesos, con la cotización que declara cada
   * comprobante. Determinístico: es `total × tasa_cambio`, no una estimación.
   */
  equivalente_uyu: equivalenteUyuSchema,
  equivalente_uyu_cobrado: equivalenteUyuSchema,
  /** Los comprobantes que forman el total (solo si incluir_comprobantes=true). */
  comprobantes: z.array(comprobanteDelTotalSchema),
  comprobantes_truncados: z.boolean(),
  /**
   * Recibos emitidos en el período (indicador_cobranza_propia=1). Es COBRO, no
   * facturación: no está incluido en `totales_por_moneda` y puede corresponder
   * a facturas de períodos anteriores.
   */
  cobrado_por_moneda: z.record(monedaTotalSchema),
  totales_por_moneda_todos_los_estados: z.record(monedaTotalSchema),
  totales_por_tipo_comprobante: z.record(tipoTotalSchema),
  conteo_por_tipo_comprobante: z.record(z.number()),
  conteo_por_estado: z.record(z.number()),
  grupos: z.array(grupoSchema),
  agrupado_por: z.array(z.string()),
  solo_aceptados: z.boolean(),
  conteo_total: z.number(),
  conteo_incluidos: z.number(),
  conteo_excluidos: z.number(),
  ventanas_consultadas: z.number(),
  warnings: z.array(z.string()),
  no_convertir_moneda: z.literal(true),
};

export async function handleResumenFacturacion(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = resumenInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  // --- Resolución del período ---------------------------------------------
  // `prioridad: "periodo"` porque esta tool lo DOCUMENTA así: si vienen los dos,
  // gana `periodo`. En el resto de las tools es al revés (ahí `periodo` tiene
  // default de schema y siempre viene, así que pisaría a desde/hasta).
  const resuelto = resolverRango({
    periodo: a.periodo,
    desde: a.desde,
    hasta: a.hasta,
    prioridad: "periodo",
  });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rango = resuelto.rango;

  try {
    const config = ctx.getConfig();

    // Consulta por CREACIÓN con margen + ventaneo + cache + recorte local por
    // EMISIÓN, todo adentro. Ver `services/ventana.ts`.
    const ventana = await traerVentana(ctx, {
      rango,
      sucursal: a.sucursal,
      ventana_dias: a.ventana_dias,
      moneda: a.moneda,
      cliente_rut: a.cliente_rut,
    });

    const resumen = resumirFacturacion(ventana.comprobantes, {
      incluir_anulados: a.incluir_anulados,
      solo_aceptados: a.solo_aceptados,
      agrupar_por: a.agrupar_por,
      nombres_sucursal: config.sucursales,
      incluir_detalle: a.incluir_comprobantes,
      limite_detalle: a.limite_comprobantes,
    });

    const warnings = [...ventana.warnings, ...resumen.warnings];

    if (a.agrupar_por?.includes("sucursal") && Object.keys(config.sucursales).length === 0) {
      warnings.push(
        "Los grupos por sucursal muestran solo el ID porque no hay nombres configurados. " +
          'Definí BILLER_SUCURSALES_JSON, ej: {"6":"Pocitos","7":"Centro"}.',
      );
    }
    if (a.agrupar_por?.includes("cliente")) {
      warnings.push(
        "La agrupación por cliente depende de que el RUT sea extraíble del campo 'cliente', cuya " +
          "estructura Biller no documenta. Los que no lo tengan caen en '(sin receptor)'.",
      );
    }

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      rango_consultado_por_creacion: ventana.rango_consultado,
      fuente: "biller:/v2/comprobantes/obtener",
      filtros_aplicados: {
        periodo: a.periodo ?? null,
        sucursal: ventana.sucursal ?? null,
        moneda: a.moneda ?? null,
        cliente_rut: a.cliente_rut ?? null,
        agrupar_por: a.agrupar_por ?? [],
        solo_aceptados: a.solo_aceptados,
        incluir_anulados: a.incluir_anulados,
        incluir_comprobantes: a.incluir_comprobantes,
      },
      totales_por_moneda: resumen.totales_por_moneda,
      equivalente_uyu: resumen.equivalente_uyu,
      equivalente_uyu_cobrado: resumen.equivalente_uyu_cobrado,
      comprobantes: resumen.detalle,
      comprobantes_truncados: resumen.detalle_truncado,
      cobrado_por_moneda: resumen.cobrado_por_moneda,
      totales_por_moneda_todos_los_estados: resumen.totales_por_moneda_todos_los_estados,
      totales_por_tipo_comprobante: resumen.totales_por_tipo_comprobante,
      conteo_por_tipo_comprobante: resumen.conteo_por_tipo_comprobante,
      conteo_por_estado: resumen.conteo_por_estado,
      grupos: resumen.grupos,
      agrupado_por: resumen.agrupado_por,
      solo_aceptados: resumen.solo_aceptados,
      conteo_total: resumen.conteo_total,
      conteo_incluidos: resumen.conteo_incluidos,
      conteo_excluidos: resumen.conteo_excluidos,
      ventanas_consultadas: ventana.ventanas,
      warnings,
      no_convertir_moneda: true,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerResumenFacturacion(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_resumen_facturacion_periodo",
    {
      title: "Resumen de facturación por período",
      description:
        "Totales de facturación de un período, por fecha de EMISIÓN fiscal. Acepta 'periodo' " +
        '("2026-06", "mes_pasado", "ultimos_30_dias") o desde/hasta. Permite agrupar por sucursal, ' +
        "día, mes, tipo, moneda o cliente — p.ej. agrupar_por=[\"sucursal\"] responde cuánto se vendió " +
        "en cada local. Por defecto cuenta solo comprobantes 'Aceptado DGI' (criterio de Biller). " +
        "Ventas suman, Notas de Crédito restan, Notas de Débito suman. El desglose por moneda no " +
        "convierte nada; además devuelve 'equivalente_uyu', la suma en pesos calculada con la " +
        "cotización que trae cada comprobante (determinístico, no es una estimación). Con " +
        "incluir_comprobantes=true lista las facturas que forman ese total, con su id.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Resumen de facturación" },
    },
    async (args) => handleResumenFacturacion(args, ctx),
  );
}
