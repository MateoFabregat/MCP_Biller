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
import { correrCuentaCorriente } from "../services/corridaCuentaCorriente.js";
import { ESTRATEGIAS, ORIGENES_IMPUTACION } from "../services/cuentaCorriente.js";
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
      origen: z.enum(ORIGENES_IMPUTACION),
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

export async function handleCuentaCorriente(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = cuentaCorrienteInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    // El default de sucursal ya no se resuelve acá: lo hace `traerVentana`, una
    // sola vez para las quince tools que lo copiaban.
    const corrida = await correrCuentaCorriente(ctx, a);
    const { resultado, hoyIso, rango, sucursal } = corrida;

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
