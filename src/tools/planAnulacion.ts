// =============================================================================
// biller_plan_anulacion
//
// "Me equivoqué en esta factura, ¿cómo la anulo?" — y la respuesta correcta,
// que no siempre es la misma:
//
//   · Si es una venta      -> nota de crédito (a veces la arma Biller solo).
//   · Si YA está anulada   -> otra NC la acreditaría dos veces. Avisa.
//   · Si es una NC         -> nota de débito, y el original revive.
//   · Si es un remito      -> ninguna de las anteriores.
//
// Es de LECTURA: consulta el comprobante, mira si ya tiene una nota de crédito
// encima, y devuelve el plan. No emite nada. Esa separación es deliberada:
// preguntar "¿cómo se deshace esto?" tiene que ser gratis y sin riesgo, para que
// la respuesta se pueda leer con calma antes de tocar el gate de escritura.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchEmitidos } from "../biller/queries.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { NOTA_CREDITO_DE, planAnulacion } from "../services/anulacion.js";
import { aIso } from "../services/periodo.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/** Ventana hacia adelante donde buscar una NC que ya anule el comprobante. */
const DIAS_BUSCAR_NC = 180;

const inputShape = {
  id: z.number().int().optional().describe("ID del comprobante en Biller. La forma más directa."),
  tipo_comprobante: z.number().int().optional().describe("Con serie y numero, identifica el CFE."),
  serie: z.string().optional(),
  numero: z.number().int().optional(),
  razon: z
    .string()
    .optional()
    .describe("Motivo de la anulación. Va como razon_referencia en la nota que se emita."),
  buscar_nota_credito_existente: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Default true: busca si el comprobante YA fue anulado antes de proponer otra nota de crédito. " +
        "Apagarlo hace la consulta más rápida, a costa de poder sugerir una doble acreditación.",
    ),
};

export const planAnulacionInputSchema = z.object(inputShape).superRefine((d, ctx) => {
  const trio = d.tipo_comprobante !== undefined && d.serie !== undefined && d.numero !== undefined;
  if (d.id === undefined && !trio) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Identificá el comprobante con 'id' o con tipo_comprobante + serie + numero.",
      path: ["id"],
    });
  }
});

const outputShape = {
  comprobante: z.object({
    id: z.number().nullable(),
    tipo_comprobante: z.number().nullable(),
    etiqueta_tipo: z.string(),
    serie: z.string().nullable(),
    numero: z.number().nullable(),
    moneda: z.string().nullable(),
    total: z.number().nullable(),
    fecha_emision: z.string().nullable(),
    estado: z.string().nullable(),
  }),
  accion: z.enum(["nota_credito", "nota_debito_reversion", "no_aplica"]),
  tipo_a_emitir: z.number().nullable(),
  etiqueta_a_emitir: z.string().nullable(),
  efecto: z.string(),
  usa_endpoint_anular: z.boolean(),
  cuerpo_sugerido: z.record(z.unknown()).nullable(),
  pasos: z.array(z.string()),
  /** Notas de crédito ya emitidas que referencian a este comprobante, si se buscaron. */
  notas_credito_encontradas: z.array(
    z.object({
      id: z.number().nullable(),
      serie: z.string().nullable(),
      numero: z.number().nullable(),
      total: z.number().nullable(),
      fecha_emision: z.string().nullable(),
      motivo_deteccion: z.string(),
    }),
  ),
  busqueda_de_anulacion: z.enum(["hecha", "omitida", "fallida"]),
  advertencias: z.array(z.string()),
  warnings: z.array(z.string()),
};

/**
 * Busca notas de crédito del mismo cliente y tipo que podrían estar anulando el
 * comprobante.
 *
 * LÍMITE HONESTO: el listado NO devuelve a qué comprobante referencia una nota
 * de crédito, así que esto es una SOSPECHA, no una certeza. Se marca cada
 * hallazgo con el motivo por el que se lo considera candidato (mismo importe,
 * mismo cliente, posterior en fecha) y la respuesta dice que hay que
 * verificarlo. Afirmar "ya está anulada" sin poder probarlo sería peor que no
 * decir nada: llevaría a emitir una nota de débito sobre una anulación que no
 * existe.
 */
async function buscarNotasCredito(
  ctx: ToolContext,
  original: ComprobanteEmitido,
): Promise<{ encontradas: Array<Record<string, unknown>>; warnings: string[] }> {
  const warnings: string[] = [];
  const tipoNc = original.tipo_comprobante === null ? undefined : NOTA_CREDITO_DE[original.tipo_comprobante];
  if (tipoNc === undefined || original.fecha_emision === null) {
    return { encontradas: [], warnings: [] };
  }

  const desde = original.fecha_emision.slice(0, 10);
  const hasta = aIso(new Date(Date.parse(`${desde}T00:00:00Z`) + DIAS_BUSCAR_NC * 86_400_000));

  // NO se filtra por `tipo_comprobante` en la consulta: Biller responde 422
  // ("Numero no puede estar vacío | Serie no puede estar vacío") cuando se envía
  // el tipo sin la terna completa. Verificado contra test.biller.uy el
  // 2026-07-28. Se trae el rango y se filtra el tipo localmente.
  const client = ctx.getClient();
  const lote = (
    await fetchEmitidos(client, {
      desde: `${desde} 00:00:00`,
      hasta: `${hasta} 23:59:59`,
    })
  ).filter((c) => c.tipo_comprobante === tipoNc);

  const rutOriginal = JSON.stringify(original.cliente ?? null);
  const encontradas = lote
    .filter((nc) => {
      const mismoImporte =
        original.total !== null && nc.total !== null && Math.abs(Math.abs(nc.total) - Math.abs(original.total)) < 0.01;
      const mismoCliente = JSON.stringify(nc.cliente ?? null) === rutOriginal;
      return mismoImporte && mismoCliente;
    })
    .map((nc) => ({
      id: nc.id,
      serie: nc.serie,
      numero: nc.numero,
      total: nc.total,
      fecha_emision: nc.fecha_emision?.slice(0, 10) ?? null,
      motivo_deteccion:
        "Mismo cliente y mismo importe que el comprobante original, emitida después. Es un " +
        "CANDIDATO: el listado no devuelve a qué comprobante referencia una nota de crédito, " +
        "así que hay que confirmarlo mirando la nota antes de darlo por anulado.",
    }));

  if (encontradas.length > 0) {
    warnings.push(
      `Se encontró ${encontradas.length} nota(s) de crédito con el mismo cliente e importe. NO es ` +
        "prueba de que el comprobante esté anulado: la API no expone la referencia de la nota. " +
        "Verificalas antes de emitir otra.",
    );
  }
  return { encontradas, warnings };
}

export async function handlePlanAnulacion(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = planAnulacionInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  try {
    const client = ctx.getClient();
    const lote = await fetchEmitidos(client, {
      id: a.id === undefined ? undefined : String(a.id),
      tipo_comprobante: a.tipo_comprobante === undefined ? undefined : String(a.tipo_comprobante),
      serie: a.serie,
      numero: a.numero === undefined ? undefined : String(a.numero),
    });

    const original = lote[0];
    if (original === undefined) {
      return simpleErrorResult(
        "No se encontró el comprobante indicado. Verificá el id (o la terna tipo+serie+número) " +
          "con biller_listar_comprobantes_emitidos.",
        ctx,
      );
    }

    let encontradas: Array<Record<string, unknown>> = [];
    let busqueda: "hecha" | "omitida" | "fallida" = "omitida";
    const warnings: string[] = [];

    if (a.buscar_nota_credito_existente) {
      try {
        const r = await buscarNotasCredito(ctx, original);
        encontradas = r.encontradas;
        warnings.push(...r.warnings);
        busqueda = "hecha";
      } catch (err) {
        busqueda = "fallida";
        warnings.push(
          "No se pudo verificar si el comprobante ya tiene una nota de crédito: " +
            `${err instanceof Error ? err.message : String(err)}. El plan asume que NO está anulado.`,
        );
      }
    }

    const plan = planAnulacion(
      {
        id: original.id,
        tipo_comprobante: original.tipo_comprobante,
        serie: original.serie,
        numero: original.numero,
        moneda: original.moneda,
        total: original.total,
        fecha_emision: original.fecha_emision?.slice(0, 10) ?? null,
        estado: original.estado,
        // Qué decide a qué TASA se acredita. Sin esto la nota salía siempre a
        // la básica y anular una factura de tasa mínima sobreacreditaba IVA.
        // Los ítems solo vienen si se consultó por id; el desglose es el
        // respaldo cuando no están. Ver `lineasNota`.
        iva: original.iva,
        items: original.items,
      },
      { ya_tiene_nota_credito: encontradas.length > 0, razon: a.razon },
    );

    return jsonResult({
      comprobante: {
        id: original.id,
        tipo_comprobante: original.tipo_comprobante,
        etiqueta_tipo:
          original.tipo_comprobante === null
            ? "(sin tipo)"
            : (TIPOS_COMPROBANTE[original.tipo_comprobante] ?? `tipo ${original.tipo_comprobante}`),
        serie: original.serie,
        numero: original.numero,
        moneda: original.moneda,
        total: original.total,
        fecha_emision: original.fecha_emision?.slice(0, 10) ?? null,
        estado: original.estado,
      },
      accion: plan.accion,
      tipo_a_emitir: plan.tipo_a_emitir,
      etiqueta_a_emitir: plan.etiqueta_a_emitir,
      efecto: plan.efecto,
      usa_endpoint_anular: plan.usa_endpoint_anular,
      cuerpo_sugerido: plan.cuerpo_sugerido,
      pasos: plan.pasos,
      notas_credito_encontradas: encontradas,
      busqueda_de_anulacion: busqueda,
      advertencias: plan.advertencias,
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerPlanAnulacion(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_plan_anulacion",
    {
      title: "Cómo anular (o revertir) un comprobante",
      description:
        "Dice QUÉ hay que emitir para dejar sin efecto un comprobante, sin emitir nada. Un CFE se " +
        "anula con una Nota de Crédito; si lo que hay que deshacer es la anulación, se emite una " +
        "Nota de Débito contra esa NC y el original vuelve a tener validez. Detecta si el " +
        "comprobante ya tiene una nota de crédito candidata para no acreditarlo dos veces, y " +
        "distingue los casos donde la nota de ajuste no corresponde (remitos, resguardos).",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Plan de anulación" },
    },
    async (args) => handlePlanAnulacion(args, ctx),
  );
}
