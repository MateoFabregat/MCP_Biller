// =============================================================================
// biller_ranking_productos
//
// Qué productos se venden más, a qué precio, y a qué cliente se le está
// haciendo más descuento sin darse cuenta (dispersión de precio unitario).
//
// COSTO ESTRUCTURAL — LÉASE ANTES DE CAMBIAR max_comprobantes POR DEFECTO:
// GET /v2/comprobantes/obtener devuelve la LISTA de comprobantes SIN el array
// `items`; el detalle de productos (código, concepto, cantidad, precio) SOLO
// viene consultando cada comprobante por `id`. Un ranking de productos es,
// por diseño de la API, un N+1: una llamada HTTP por comprobante analizado.
// Esta tool no lo esconde: acota cuántos comprobantes se detallan
// (`max_comprobantes`, default 100, máx 500) y DECLARA qué proporción de la
// facturación del período quedó cubierta (`cobertura`) cuando hay que
// truncar. Un ranking sobre el 30% de la facturación no es un ranking.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { round2 } from "../biller/coerce.js";
import { traerPorId } from "../biller/traerDetalles.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { importeFacturadoEnMoneda } from "../services/comprobanteFilters.js";
import { PERIODOS_SOPORTADOS } from "../services/periodo.js";
import { UMBRAL_DISPERSION_PCT, rankingProductos } from "../services/rankingProductos.js";
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

/** Tope de comprobantes a detallar por id. Cada uno es una llamada HTTP extra. */
export const MAX_COMPROBANTES_DEFAULT = 100;
export const MAX_COMPROBANTES_TOPE = 500;

const inputShape = {
  periodo: z
    .string()
    .optional()
    .default("ultimos_90_dias")
    .describe(
      `Período por fecha de EMISIÓN. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: ultimos_90_dias.",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  max_comprobantes: z
    .number()
    .int()
    .positive()
    .max(MAX_COMPROBANTES_TOPE)
    .optional()
    .default(MAX_COMPROBANTES_DEFAULT)
    .describe(
      `Cuántos comprobantes del período se detallan por 'id' para leer sus productos (default ` +
        `${MAX_COMPROBANTES_DEFAULT}, máx ${MAX_COMPROBANTES_TOPE}). Cada uno es una llamada HTTP extra ` +
        "(N+1): Biller no incluye 'items' en el listado. Se prioriza por TOTAL descendente, así que un " +
        "recorte afecta menos al importe cubierto que a la cantidad de comprobantes. Ver 'cobertura' en la respuesta.",
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo comprobantes "Aceptado DGI" (criterio que usa Biller). Default: true.'),
  moneda: z
    .string()
    .optional()
    .describe("Moneda para ordenar el ranking. Default: la de mayor importe entre lo analizado."),
  sucursal: z.string().optional().describe("Filtra a una sola sucursal (ID real de Biller)."),
  limite: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(20)
    .describe("Cuántos productos devolver, del que más importa al que menos."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const rankingProductosInputSchema = z.object(inputShape);

const clientePrecioSchema = z.object({
  rut: z.string().nullable(),
  nombre: z.string().nullable(),
  precio_unitario_promedio: z.number(),
});

const productoSchema = z.object({
  codigo: z.string().nullable(),
  concepto: z.string().nullable(),
  unidades: z.number(),
  importe_por_moneda: z.record(z.number()),
  comprobantes: z.number(),
  clientes_distintos: z.number(),
  precio_unitario_min: z.number().nullable(),
  precio_unitario_max: z.number().nullable(),
  precio_unitario_promedio_ponderado: z.number().nullable(),
  dispersion_pct: z.number().nullable(),
  dispersion_alta: z.boolean(),
  clientes_precio: z.array(clientePrecioSchema),
  primera_venta: z.string().nullable(),
  ultima_venta: z.string().nullable(),
});

const coberturaSchema = z.object({
  /** Comprobantes encontrados en el período tras el filtro por fecha de emisión (antes de truncar). */
  comprobantes_del_periodo: z.number(),
  /** Comprobantes efectivamente analizados (con detalle de items, aceptados, con moneda). */
  comprobantes_analizados: z.number(),
  /** % del importe calificado del período que cubren los comprobantes analizados. null si no hay base. */
  cobertura_importe_pct: z.number().nullable(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  productos: z.array(productoSchema),
  moneda_orden: z.string(),
  monedas_presentes: z.array(z.string()),
  total_importe_por_moneda: z.record(z.number()),
  productos_totales: z.number(),
  comprobantes_analizados: z.number(),
  cobertura: coberturaSchema,
  ventanas_consultadas: z.number(),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

/**
 * Detalla por 'id' los comprobantes ya seleccionados, para leer sus `items`.
 * Un fallo individual (HTTP, o respuesta vacía) no aborta el resto: se cuenta
 * y se avisa.
 *
 * El N+1 corre en paralelo acotado, con reintento y con cache: ver
 * `biller/traerDetalles.ts`. Antes era un bucle en serie, y con el tope de 500
 * comprobantes eso son más de tres minutos de espera para una sola pregunta.
 */
async function cargarItems(
  ctx: ToolContext,
  seleccionados: ComprobanteEmitido[],
): Promise<{ comprobantes: ComprobanteEmitido[]; fallidos: number }> {
  const ids = seleccionados.filter((c) => c.id !== null).map((c) => c.id!);
  // Un comprobante sin `id` no se puede detallar: cuenta como fallido igual que
  // antes, sin gastar una request en averiguarlo.
  const sinId = seleccionados.length - ids.length;

  const { detalles, fallidos } = await traerPorId(ctx.getClient(), ids);

  // El orden es el de `seleccionados` (total descendente), no el de llegada:
  // dos corridas idénticas tienen que devolver el mismo ranking.
  const comprobantes = ids
    .map((id) => detalles.get(id))
    .filter((c): c is ComprobanteEmitido => c !== undefined);

  return { comprobantes, fallidos: sinId + fallidos.length };
}

export async function handleRankingProductos(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = rankingProductosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const resuelto = resolverRango({ periodo: a.periodo, desde: a.desde, hasta: a.hasta });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rango = resuelto.rango;

  try {
    const ventana = await traerVentana(ctx, {
      rango,
      sucursal: a.sucursal,
      ventana_dias: a.ventana_dias,
    });

    // Truncar por TOTAL descendente: si hay que recortar, priorizar los
    // comprobantes de mayor importe hace que el ranking resultante sea lo más
    // representativo posible de la facturación real. La cobertura efectiva
    // se declara más abajo, no se asume.
    const ordenados = [...ventana.comprobantes].sort((x, y) => (y.total ?? 0) - (x.total ?? 0));
    const seleccionados = ordenados.slice(0, a.max_comprobantes);

    const { comprobantes: comprobantesConItems, fallidos } = await cargarItems(ctx, seleccionados);

    const resultado = rankingProductos(comprobantesConItems, {
      moneda: a.moneda,
      solo_aceptados: a.solo_aceptados,
      limite: a.limite,
    });

    // --- Cobertura -------------------------------------------------------
    // Numerador y denominador salen de la MISMA función —la regla fiscal vive
    // en services, no acá— y con la misma moneda: comparar dos importes
    // calculados con criterios distintos daría un porcentaje que no significa
    // nada, y que igual se publicaría sin que nada falle.
    const importeTotalPeriodo = importeFacturadoEnMoneda(
      ventana.comprobantes,
      resultado.moneda_orden,
      a.solo_aceptados,
    );
    const importeAnalizado = importeFacturadoEnMoneda(
      comprobantesConItems,
      resultado.moneda_orden,
      a.solo_aceptados,
    );
    const coberturaImportePct =
      importeTotalPeriodo !== 0 ? round2((importeAnalizado / importeTotalPeriodo) * 100) : null;

    const warningsExtra: string[] = [];
    if (ventana.comprobantes.length > a.max_comprobantes) {
      warningsExtra.push(
        `Había ${ventana.comprobantes.length} comprobante(s) en el período y se detalló el de ` +
          `${seleccionados.length} (max_comprobantes=${a.max_comprobantes}), priorizando los de mayor ` +
          `total. Cobertura de importe cubierta: ${coberturaImportePct ?? "sin base para calcularla"}% ` +
          `en ${resultado.moneda_orden}. Un ranking sobre una porción chica de la facturación no es ` +
          "representativo: subí max_comprobantes o acotá el período.",
      );
    }
    if (fallidos > 0) {
      warningsExtra.push(
        `${fallidos} de los comprobantes seleccionados no se pudieron consultar por 'id' (sin id, sin ` +
          "respuesta, o error): se excluyeron del ranking sin abortar el resto.",
      );
    }

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      fuente: "biller:/v2/comprobantes/obtener",
      productos: resultado.productos,
      moneda_orden: resultado.moneda_orden,
      monedas_presentes: resultado.monedas_presentes,
      total_importe_por_moneda: resultado.total_importe_por_moneda,
      productos_totales: resultado.productos_totales,
      comprobantes_analizados: resultado.comprobantes_analizados,
      cobertura: {
        comprobantes_del_periodo: ventana.comprobantes.length,
        comprobantes_analizados: resultado.comprobantes_analizados,
        cobertura_importe_pct: coberturaImportePct,
      },
      ventanas_consultadas: ventana.ventanas,
      no_convertir_moneda: true,
      warnings: [...ventana.warnings, ...warningsExtra, ...resultado.warnings],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerRankingProductos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_ranking_productos",
    {
      title: "Ranking de productos",
      description:
        "Qué productos se venden más y a qué precio, con dispersión de precio unitario por cliente " +
        `(umbral default ${UMBRAL_DISPERSION_PCT}%): responde '¿a qué cliente le estoy haciendo más ` +
        "descuento sin darme cuenta?'. Es un N+1 acotado: Biller solo devuelve los items de un " +
        "comprobante al consultarlo por 'id', así que se detalla como máximo 'max_comprobantes' " +
        "(priorizando los de mayor importe) y la respuesta declara qué % de la facturación del período " +
        "quedó efectivamente cubierta ('cobertura'). NO calcula margen (Biller no tiene el costo del " +
        "producto) ni convierte monedas.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Ranking de productos" },
    },
    async (args) => handleRankingProductos(args, ctx),
  );
}
