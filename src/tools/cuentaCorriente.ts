// =============================================================================
// biller_cuenta_corriente
//
// "¿Quién me debe plata?" — deuda NETA, no facturación bruta.
//
// Se apoya en que un recibo es un CFE y vuelve en el mismo
// GET /v2/comprobantes/obtener con `indicador_cobranza_propia = 1`, así que
// facturas, notas de crédito y cobros salen todos de la misma consulta.
//
// COSTO: el listado alcanza para el saldo por cliente. Para saber QUÉ factura
// quedó impaga hay que imputar cada cobro, y el listado no trae las referencias
// del recibo: hay que pedirlo por `id`. Ese N+1 corre SOLO sobre los recibos
// (bastantes menos que las facturas) y se puede apagar con
// `imputar_por_referencias=false`, en cuyo caso la imputación es FIFO.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { classifyCfe } from "../services/cfeTypes.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import {
  ESTRATEGIAS,
  calcularCuentaCorriente,
  referenciasDeRecibo,
  type CuentaCorrienteResultado,
  type ReferenciaCobranza,
} from "../services/cuentaCorriente.js";
import { aIso, consultarPorPeriodo } from "../services/periodo.js";
import { BUCKETS } from "../services/vencimientos.js";
import {
  READ_ONLY_ANNOTATIONS,
  applyLimit,
  errorToolResult,
  jsonResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/** Ventana hacia atrás por defecto: la deuda vieja es justamente la que importa. */
const DIAS_ATRAS_DEFAULT = 365;

/** Tope de consultas de detalle, para no disparar cientos de llamadas sin aviso. */
const MAX_DETALLE_RECIBOS = 50;

const inputShape = {
  dias_atras: z
    .number()
    .int()
    .min(1)
    .max(1095)
    .optional()
    .default(DIAS_ATRAS_DEFAULT)
    .describe(
      `Ventana de emisión hacia atrás (default ${DIAS_ATRAS_DEFAULT}). Tiene que cubrir TANTO las ` +
        "facturas como sus cobros: si entra la factura pero no el recibo, la deuda sale inflada.",
    ),
  imputar_por_referencias: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true: consulta cada recibo por id para leer a qué comprobante se imputó (1 llamada " +
        "por recibo). Esa consulta es la ÚNICA forma de saberlo: el listado no trae los ítems del " +
        "recibo, y la imputación viene en el concepto de esos ítems. En false, imputa FIFO sin " +
        "llamadas extra y el saldo por factura queda estimado.",
    ),
  solo_a_credito: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true: descarta el contado (sin fecha_vencimiento, o vencimiento <= emisión). " +
        "Biller no expone forma_pago en el GET.",
    ),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe("Default true: considera solo comprobantes en estado 'Aceptado DGI'."),
  incluir_canceladas: z
    .boolean()
    .optional()
    .default(false)
    .describe("Incluir en el detalle las facturas ya cobradas por completo (default false)."),
  sucursal: z.string().optional().describe("Filtra la consulta a una sola sucursal (ID de Biller)."),
  moneda: z.string().optional().describe("Filtro LOCAL por moneda (ej: UYU, USD)."),
  cliente_rut: z
    .string()
    .optional()
    .describe("Filtro LOCAL por RUT. Ojo: acota también los cobros, así que se aplica DESPUÉS de imputar."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(200)
    .describe("Máximo de documentos en el detalle. Los totales se calculan sobre TODOS."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const cuentaCorrienteInputSchema = z.object(inputShape);

const montoPorMonedaSchema = z.object({ total: z.number(), comprobantes: z.number() });

const documentoSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  etiqueta_tipo: z.string(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  fecha_emision: z.string().nullable(),
  fecha_vencimiento: z.string().nullable(),
  cliente_rut: z.string().nullable(),
  cliente_nombre: z.string().nullable(),
  moneda: z.string(),
  total: z.number(),
  cobrado: z.number(),
  saldo: z.number(),
  estado_cobro: z.enum(["pendiente", "parcial", "cancelada"]),
  dias_para_vencer: z.number().nullable(),
  bucket: z.enum(BUCKETS).nullable(),
  estado: z.string().nullable(),
  sucursal: z.number().nullable(),
});

const clienteSchema = z.object({
  cliente_rut: z.string().nullable(),
  cliente_nombre: z.string().nullable(),
  saldo_por_moneda: z.record(montoPorMonedaSchema),
  vencido_por_moneda: z.record(montoPorMonedaSchema),
  saldo_a_favor_por_moneda: z.record(z.number()),
  facturado_por_moneda: z.record(z.number()),
  cobrado_por_moneda: z.record(z.number()),
  documentos_pendientes: z.number(),
  dias_atraso_maximo: z.number(),
});

const outputShape = {
  hoy: z.string(),
  ventana: z.object({ emitidas_desde: z.string(), emitidas_hasta: z.string() }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  filtros_aplicados: z.record(z.unknown()),
  /** "referencias" = exacta. "fifo"/"mixta" = el saldo POR FACTURA es estimado. */
  // El vocabulario sale del servicio, no de una lista escrita a mano acá: las
  // dos ya se desincronizaron una vez (la tool decía "referencias", que el
  // servicio nunca devolvió, y le faltaba "exacta") y rompía en su mejor caso.
  estrategia: z.enum(ESTRATEGIAS),
  imputacion_exacta: z.boolean(),
  saldo_por_moneda: z.record(montoPorMonedaSchema),
  vencido_por_moneda: z.record(montoPorMonedaSchema),
  por_vencer_por_moneda: z.record(montoPorMonedaSchema),
  saldo_a_favor_por_moneda: z.record(z.number()),
  resumen_por_bucket: z.array(
    z.object({
      bucket: z.enum(BUCKETS),
      etiqueta: z.string(),
      vencida: z.boolean(),
      totales_por_moneda: z.record(montoPorMonedaSchema),
      conteo: z.number(),
    }),
  ),
  por_cliente: z.array(clienteSchema),
  documentos: z.array(documentoSchema),
  cobranzas: z.array(
    z.object({
      recibo_id: z.number().nullable(),
      serie: z.string().nullable(),
      numero: z.number().nullable(),
      fecha_emision: z.string().nullable(),
      moneda: z.string(),
      monto: z.number(),
      imputado: z.number(),
      sin_imputar: z.number(),
      cliente_rut: z.string().nullable(),
      origen: z.enum(["referencias", "fifo"]),
    }),
  ),
  totales: z.object({
    facturado_por_moneda: z.record(z.number()),
    cobrado_por_moneda: z.record(z.number()),
  }),
  conteo: z.record(z.number()),
  excluidos: z.record(z.number()),
  ventanas_consultadas: z.number(),
  detalles_consultados: z.number(),
  warnings: z.array(z.string()),
  no_convertir_moneda: z.literal(true),
};

/**
 * Trae el detalle de cada recibo para leer a qué facturas se imputó.
 *
 * Por qué hace falta una llamada por recibo: el listado devuelve `items: null`
 * y la imputación de un recibo vive en el CONCEPTO de sus ítems (verificado
 * contra la API real). Sin esta consulta no hay forma de saber qué factura
 * pagó cada cobro, y todo cae a FIFO.
 *
 * Devuelve un mapa id -> referencias. Los recibos cuyo detalle no aporta nada
 * quedan fuera del mapa, y el servicio los imputa por FIFO.
 */
async function cargarReferencias(
  ctx: ToolContext,
  recibos: ComprobanteEmitido[],
): Promise<{ mapa: Map<number, ReferenciaCobranza[]>; consultados: number; warnings: string[] }> {
  const mapa = new Map<number, ReferenciaCobranza[]>();
  const warnings: string[] = [];
  const conId = recibos.filter((r) => r.id !== null);

  const aConsultar = conId.slice(0, MAX_DETALLE_RECIBOS);
  if (conId.length > MAX_DETALLE_RECIBOS) {
    warnings.push(
      `Hay ${conId.length} recibos y se consultó el detalle de los primeros ${MAX_DETALLE_RECIBOS} ` +
        "para no disparar cientos de llamadas. El resto se imputó por FIFO. Acotá el período o " +
        "el rango para una imputación completa.",
    );
  }

  const client = ctx.getClient();
  for (const r of aConsultar) {
    try {
      const detalle = await fetchEmitidos(client, { id: String(r.id) });
      // `referenciasDeRecibo` mira primero un campo `referencias` y después el
      // concepto de los ítems, que es de donde salen HOY (ver cuentaCorriente.ts).
      const refs = detalle[0] === undefined ? null : referenciasDeRecibo(detalle[0]);
      if (refs !== null) mapa.set(r.id!, refs);
    } catch {
      // Un detalle que falla no invalida el resto: ese recibo cae a FIFO.
      warnings.push(
        `No se pudo consultar el detalle del recibo ${r.id}: se imputó por FIFO en vez de por referencias.`,
      );
    }
  }

  if (aConsultar.length > 0 && mapa.size === 0) {
    warnings.push(
      `Se consultó el detalle de ${aConsultar.length} recibo(s) y NINGUNO devolvió referencias al ` +
        "comprobante que paga. La imputación por factura es FIFO (estimada). El saldo por cliente " +
        "no se ve afectado: ese sí es exacto.",
    );
  }

  return { mapa, consultados: aConsultar.length, warnings };
}

/** Parámetros de la corrida de cuenta corriente, ya con defaults resueltos. */
export interface CorridaCuentaCorriente {
  dias_atras: number;
  imputar_por_referencias: boolean;
  solo_a_credito: boolean;
  solo_aceptados: boolean;
  incluir_canceladas: boolean;
  sucursal?: string;
  ventana_dias?: number;
  /**
   * Saltea la lectura del cache de ventanas. Solo para el paso de confirmación
   * de algo que sale hacia afuera: ver `consultarPorPeriodo`.
   */
  sin_cache?: boolean;
}

export interface ResultadoCorrida {
  resultado: CuentaCorrienteResultado;
  hoy: Date;
  hoyIso: string;
  rango: { desde: string; hasta: string };
  ventanas: number;
  detalles_consultados: number;
  warnings: string[];
}

/**
 * Trae los comprobantes, imputa los cobros y calcula la cuenta corriente.
 *
 * Vive acá y no en `services/` porque hace I/O: la imputación exacta necesita
 * una llamada por recibo (ver `cargarReferencias`). Está exportada porque el
 * recordatorio de cobro (`biller_recordatorio_cobro`) tiene que calcular la
 * MISMA deuda con el MISMO criterio — si cada tool armara la suya, el número
 * que se le muestra al dueño y el que se le manda al cliente podrían diferir,
 * y esa diferencia se descubriría en el peor lugar posible.
 */
export async function correrCuentaCorriente(
  ctx: ToolContext,
  a: CorridaCuentaCorriente,
): Promise<ResultadoCorrida> {
  const config = ctx.getConfig();
  const client = ctx.getClient();
  const sucursal = a.sucursal ?? config.defaultSucursalId;

  const hoy = new Date();
  const hoyIso = aIso(hoy);
  const desde = aIso(new Date(hoy.getTime() - a.dias_atras * 86_400_000));
  const rango = { desde, hasta: hoyIso };

  const consulta = await consultarPorPeriodo(client, rango, {
    sucursal,
    ventanaDias: a.ventana_dias,
    sinCache: a.sin_cache,
  });

  // Filtro local por EMISIÓN (la API filtra por creación). El filtro por
  // cliente/moneda NO se aplica acá: sacar cobros antes de imputar inflaría
  // la deuda. Se aplica sobre el resultado.
  const filtered = filterEmitidos(consulta.comprobantes, {
    emitidas_desde: rango.desde,
    emitidas_hasta: rango.hasta,
  });

  // Detalle de recibos, para imputar por referencias reales.
  let referenciasPorId = new Map<number, ReferenciaCobranza[]>();
  let detallesConsultados = 0;
  const warningsDetalle: string[] = [];
  if (a.imputar_por_referencias) {
    const recibos = filtered.list.filter(
      (c) => classifyCfe(c.tipo_comprobante, c.indicador_cobranza_propia).categoria === "cobranza",
    );
    if (recibos.length > 0) {
      const cargadas = await cargarReferencias(ctx, recibos);
      referenciasPorId = cargadas.mapa;
      detallesConsultados = cargadas.consultados;
      warningsDetalle.push(...cargadas.warnings);
    }
  }

  const resultado = calcularCuentaCorriente(filtered.list, {
    hoy,
    solo_aceptados: a.solo_aceptados,
    solo_a_credito: a.solo_a_credito,
    incluir_canceladas: a.incluir_canceladas,
    resolverReferencias: (c) =>
      (c.id !== null ? referenciasPorId.get(c.id) : undefined) ?? referenciasDeRecibo(c),
  });

  return {
    resultado,
    hoy,
    hoyIso,
    rango,
    ventanas: consulta.ventanas,
    detalles_consultados: detallesConsultados,
    warnings: [...consulta.warnings, ...filtered.warnings, ...warningsDetalle],
  };
}

export async function handleCuentaCorriente(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = cuentaCorrienteInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const config = ctx.getConfig();
    const sucursal = a.sucursal ?? config.defaultSucursalId;
    const corrida = await correrCuentaCorriente(ctx, { ...a, sucursal });
    const { resultado, hoyIso, rango } = corrida;

    // Filtros de presentación, ya imputado.
    const coincide = (rut: string | null, moneda: string): boolean =>
      (a.cliente_rut === undefined || rut === a.cliente_rut) &&
      (a.moneda === undefined || moneda === a.moneda);

    const documentos = resultado.documentos.filter((d) => coincide(d.cliente_rut, d.moneda));
    const porCliente =
      a.cliente_rut === undefined
        ? resultado.por_cliente
        : resultado.por_cliente.filter((c) => c.cliente_rut === a.cliente_rut);
    const limitado = applyLimit(documentos, a.limit);

    return jsonResult({
      hoy: hoyIso,
      ventana: { emitidas_desde: rango.desde, emitidas_hasta: rango.hasta },
      fuente: "biller:/v2/comprobantes/obtener",
      filtros_aplicados: {
        sucursal: sucursal ?? null,
        moneda: a.moneda ?? null,
        cliente_rut: a.cliente_rut ?? null,
        solo_aceptados: a.solo_aceptados,
        solo_a_credito: a.solo_a_credito,
        incluir_canceladas: a.incluir_canceladas,
        imputar_por_referencias: a.imputar_por_referencias,
        dias_atras: a.dias_atras,
      },
      estrategia: resultado.estrategia,
      imputacion_exacta: resultado.imputacion_exacta,
      saldo_por_moneda: resultado.saldo_por_moneda,
      vencido_por_moneda: resultado.vencido_por_moneda,
      por_vencer_por_moneda: resultado.por_vencer_por_moneda,
      saldo_a_favor_por_moneda: resultado.saldo_a_favor_por_moneda,
      resumen_por_bucket: resultado.resumen_por_bucket,
      por_cliente: porCliente,
      documentos: limitado.list,
      cobranzas: resultado.cobranzas,
      totales: resultado.totales,
      conteo: { ...resultado.conteo },
      excluidos: { ...resultado.excluidos },
      ventanas_consultadas: corrida.ventanas,
      detalles_consultados: corrida.detalles_consultados,
      warnings: [
        ...corrida.warnings,
        ...resultado.warnings,
        ...limitado.warnings,
        `Solo se miraron comprobantes emitidos desde ${rango.desde}. Una factura o un cobro anterior ` +
          "a esa fecha no entra en el cálculo: subí 'dias_atras' si arrastrás deuda vieja.",
      ],
      no_convertir_moneda: true,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerCuentaCorriente(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_cuenta_corriente",
    {
      title: "Cuenta corriente: deuda neta por cliente",
      description:
        "Deuda NETA por cliente y por factura: lo facturado a crédito MENOS lo cobrado. " +
        "Responde '¿quién me debe plata?', '¿esta factura está paga?' y '¿cuánto me deben vencido?'. " +
        "Los cobros salen de los recibos, que son CFE y vuelven en el mismo GET de comprobantes " +
        "(indicador_cobranza_propia=1); soporta recibos totales y parciales. " +
        "El saldo POR CLIENTE es exacto. El saldo POR FACTURA depende de 'estrategia': con " +
        "'referencias' es exacto, con 'fifo'/'mixta' es una estimación (lo más viejo primero) y hay " +
        "que aclararlo al responder. Para el bruto sin descontar cobros, usar biller_vencimientos.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Cuenta corriente" },
    },
    async (args) => handleCuentaCorriente(args, ctx),
  );
}
