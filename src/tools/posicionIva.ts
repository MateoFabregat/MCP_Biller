// =============================================================================
// biller_posicion_iva
//
// IVA ventas − IVA compras del período. Cruza los dos endpoints de lectura de
// comprobantes: emitidos (débito) y recibidos (crédito).
//
// Los recibidos se consultan por VENTANAS igual que los emitidos: el endpoint
// está limitado a 1 req/seg y también falla con rangos amplios.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ComprobanteRecibido } from "../biller/types.js";
import { PERIODOS_SOPORTADOS } from "../services/periodo.js";
import { LIMITACIONES_IVA, calcularPosicionIva } from "../services/posicionIva.js";
import { resolverRango, traerVentana, traerVentanaRecibidos } from "../services/ventana.js";
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
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo emitidos "Aceptado DGI". Default: true.'),
  incluir_compras: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Consultar comprobantes recibidos para el IVA crédito. Si es false, devuelve solo el débito " +
        "(más rápido, pero el número NO es la posición real).",
    ),
  sucursal: z.string().optional().describe("Filtra los emitidos a una sola sucursal (ID real de Biller)."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const posicionIvaInputSchema = z.object(inputShape);

const ivaPorTasaSchema = z.object({
  tasa_minima: z.number(),
  tasa_basica: z.number(),
  tasa_otra: z.number(),
  total: z.number(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  fuente: z.literal("biller:/v2/comprobantes/obtener + /v2/comprobantes/recibidos/obtener"),
  lectura: z.string(),
  por_moneda: z.array(
    z.object({
      moneda: z.string(),
      debito: ivaPorTasaSchema,
      credito: z.number(),
      posicion: z.number(),
      retenciones_sufridas: z.number(),
      comprobantes_emitidos: z.number(),
      comprobantes_recibidos: z.number(),
    }),
  ),
  moneda_principal: z.string().nullable(),
  es_estimacion: z.literal(true),
  limitaciones: z.array(z.string()),
  emitidos_analizados: z.number(),
  recibidos_analizados: z.number(),
  incluyo_compras: z.boolean(),
  ventanas_consultadas: z.number(),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handlePosicionIva(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = posicionIvaInputSchema.safeParse(args);
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

    let recibidos: ComprobanteRecibido[] = [];
    let ventanasRecibidos = 0;
    let warningsRecibidos: string[] = [];
    if (a.incluir_compras) {
      const r = await traerVentanaRecibidos(ctx, rango, {
        ventana_dias: a.ventana_dias,
      });
      recibidos = r.comprobantes;
      ventanasRecibidos = r.ventanas;
      warningsRecibidos = r.warnings;
    }

    const resultado = calcularPosicionIva(ventana.comprobantes, recibidos, {
      solo_aceptados: a.solo_aceptados,
    });

    const warnings = [...ventana.warnings, ...warningsRecibidos, ...resultado.warnings];
    if (!a.incluir_compras) {
      warnings.unshift(
        "incluir_compras=false: NO se consultaron los comprobantes recibidos. El número mostrado es " +
          "el IVA débito, no la posición de IVA. No lo uses para decidir cuánto pagar.",
      );
    }

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      fuente: "biller:/v2/comprobantes/obtener + /v2/comprobantes/recibidos/obtener",
      lectura: resultado.lectura,
      por_moneda: resultado.por_moneda,
      moneda_principal: resultado.moneda_principal,
      es_estimacion: true,
      limitaciones: LIMITACIONES_IVA,
      emitidos_analizados: resultado.emitidos_analizados,
      recibidos_analizados: resultado.recibidos_analizados,
      incluyo_compras: a.incluir_compras,
      ventanas_consultadas: ventana.ventanas + ventanasRecibidos,
      no_convertir_moneda: true,
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerPosicionIva(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_posicion_iva",
    {
      title: "Posición de IVA estimada",
      description:
        "Estima el IVA del período: débito (de los comprobantes emitidos, por tasa mínima/básica/otra) " +
        "menos crédito (del IVA de los comprobantes recibidos). Contesta '¿cuánto me da IVA este mes?' " +
        "sin esperar al contador. ES UNA ESTIMACIÓN DE GESTIÓN, NO UNA DECLARACIÓN JURADA: no incluye " +
        "importaciones, prorrata por exentos ni ajustes contables, y las retenciones se informan " +
        "aparte sin descontarse. La respuesta lista todas las limitaciones.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Posición de IVA estimada" },
    },
    async (args) => handlePosicionIva(args, ctx),
  );
}
