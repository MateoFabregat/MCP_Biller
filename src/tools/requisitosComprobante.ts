// =============================================================================
// biller_requisitos_comprobante
//
// "Quiero facturarle a Carbonell" → "Ok, necesito esto, esto y esto."
//
// Es una tool de LECTURA que no toca la red: convierte la Tabla de Valores de
// Biller y las reglas de DGI en una lista de lo que falta, con UNA pregunta por
// vez. Existe por el canal, no por el protocolo: en un chat de WhatsApp nadie
// va a mandar un JSON con `indicador_facturacion`, y pedirle seis campos juntos
// a alguien que está atendiendo el mostrador garantiza que no conteste ninguno.
//
// Por qué es read-only y separada de `biller_emitir_comprobante`: preguntar qué
// hace falta tiene que poder hacerse mil veces, gratis, sin ninguna barrera y
// sin riesgo de emitir nada por accidente. La tool de emisión conserva TODO su
// gate; esta es la que hace que llegar a ese gate no sea adivinar.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIPOS_COMPROBANTE } from "../biller/cfeSchema.js";
import { evaluarRequisitos, resolverUmbralReceptor } from "../biller/requisitos.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  type ToolContext,
  type ToolResult,
  validationErrorResult,
} from "./shared.js";

const inputShape = {
  tipo_comprobante: z
    .number()
    .int()
    .describe(
      "Qué se quiere emitir. Los habituales: 101 e-Ticket (consumidor final), 111 e-Factura " +
        "(empresa con RUT), 112 Nota de Crédito de e-Factura (anula/ajusta), 113 Nota de Débito.",
    ),
  datos_conocidos: z
    .record(z.unknown())
    .optional()
    .describe(
      "Lo que ya se sabe del comprobante, con la misma forma que el cuerpo de " +
        "biller_emitir_comprobante. Sirve para que la respuesta diga qué FALTA, no todo lo que existe.",
    ),
  total_estimado: z
    .number()
    .optional()
    .describe(
      "Importe aproximado del comprobante, EN LA MONEDA del comprobante. Habilita el chequeo del " +
        "umbral de UI. Si la moneda no es UYU hace falta también 'tasa_cambio' (o " +
        "datos_conocidos.tasa_cambio): el umbral está en Unidades Indexadas, que son pesos.",
    ),
  tasa_cambio: z
    .number()
    .positive()
    .optional()
    .describe("Cotización a pesos, si el comprobante no está en UYU. Sin esto el umbral no se evalúa."),
};

export const requisitosInputSchema = z.object(inputShape);

const requisitoSchema = z.object({
  campo: z.string(),
  obligatoriedad: z.enum(["siempre", "condicional", "recomendado"]),
  condicion: z.string().optional(),
  detalle: z.string(),
  pregunta: z.string(),
  ejemplo: z.unknown().optional(),
});

const outputShape = {
  tipo_comprobante: z.number(),
  etiqueta: z.string(),
  listo_para_emitir: z.boolean(),
  /** La única pregunta que conviene hacer ahora. null si no falta nada. */
  siguiente_pregunta: z.string().nullable(),
  faltantes: z.array(requisitoSchema),
  requisitos: z.array(requisitoSchema),
  reglas_dgi: z.array(z.string()),
  umbral_receptor: z.object({
    umbral_ui: z.number(),
    valor_ui: z.number(),
    valor_ui_configurado: z.boolean(),
    valor_ui_fecha: z.string().nullable(),
    umbral_uyu: z.number(),
    nota: z.string(),
  }),
  ejemplo_minimo: z.record(z.unknown()),
  como_sigue: z.string(),
  advertencias: z.array(z.string()),
};

export function handleRequisitosComprobante(args: unknown, ctx: ToolContext): ToolResult {
  const parsed = requisitosInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  if (!(a.tipo_comprobante in TIPOS_COMPROBANTE)) {
    return simpleErrorResult(
      `El tipo ${a.tipo_comprobante} no está en la tabla de valores de Biller. ` +
        `Válidos: ${Object.entries(TIPOS_COMPROBANTE).map(([k, v]) => `${k} (${v})`).join(", ")}.`,
      ctx,
    );
  }

  try {
    // La config es OPCIONAL acá: sin ella la tool sigue contestando, con el
    // valor de UI de referencia y avisando. Poder preguntar "qué necesito"
    // antes de tener el server configurado es justamente parte del onboarding.
    let valorUi: number | undefined;
    let valorUiFecha: string | undefined;
    let umbralUi: number | undefined;
    let sucursalPorDefecto = false;
    try {
      const c = ctx.getConfig();
      valorUi = c.valorUi;
      valorUiFecha = c.valorUiFecha;
      umbralUi = c.umbralUiReceptor;
      sucursalPorDefecto = c.defaultSucursalId !== undefined;
    } catch {
      /* sin configuración: se contesta igual */
    }

    // El umbral de DGI está en Unidades Indexadas, que son PESOS. Un importe en
    // otra moneda hay que convertirlo antes o no se puede evaluar: un e-Ticket
    // de USD 1.000 son ~$40.000 y está muy por encima del umbral, pero leído
    // como si fueran pesos contestaría "el receptor es opcional" — y esa es
    // exactamente la respuesta que hace emitir mal.
    const conocidos = a.datos_conocidos ?? {};
    const moneda = String(conocidos.moneda ?? "UYU").toUpperCase();
    const tasa =
      a.tasa_cambio ??
      (typeof conocidos.tasa_cambio === "number" ? conocidos.tasa_cambio : undefined);

    let totalUyu: number | null = null;
    let avisoMoneda: string | null = null;
    if (a.total_estimado !== undefined) {
      if (moneda === "UYU") {
        totalUyu = a.total_estimado;
      } else if (tasa !== undefined && tasa > 0) {
        totalUyu = a.total_estimado * tasa;
      } else {
        avisoMoneda =
          `El importe vino en ${moneda} y no se pasó 'tasa_cambio', así que NO se pudo verificar el ` +
          "umbral de UI (que está en pesos). Si el comprobante lo supera, identificar al receptor " +
          "es obligatorio: pasá la cotización para saberlo.";
      }
    }

    const opciones = {
      valor_ui: valorUi,
      valor_ui_fecha: valorUiFecha,
      umbral_ui: umbralUi,
      total_uyu: totalUyu,
      sucursal_por_defecto: sucursalPorDefecto,
    };

    const ev = evaluarRequisitos(a.tipo_comprobante, a.datos_conocidos ?? {}, opciones);

    return jsonResult({
      tipo_comprobante: ev.tipo_comprobante,
      etiqueta: ev.etiqueta,
      listo_para_emitir: ev.listo_para_emitir,
      siguiente_pregunta: ev.siguiente_pregunta,
      faltantes: ev.faltantes,
      requisitos: ev.requisitos,
      reglas_dgi: ev.reglas_dgi,
      umbral_receptor: resolverUmbralReceptor(opciones),
      ejemplo_minimo: ev.ejemplo_minimo,
      como_sigue: ev.listo_para_emitir
        ? "No falta nada obligatorio. El próximo paso es biller_emitir_comprobante en dry-run " +
          "(sin confirm): devuelve el total calculado y las advertencias para leer ANTES de emitir."
        : `Falta${ev.faltantes.length === 1 ? "" : "n"} ${ev.faltantes.length} dato(s). ` +
          "Preguntá de a uno (empezá por 'siguiente_pregunta'), volvé a llamar esta tool con lo " +
          "que ya juntaste en 'datos_conocidos', y cuando listo_para_emitir sea true pasá al dry-run.",
      advertencias: avisoMoneda === null ? ev.advertencias : [avisoMoneda, ...ev.advertencias],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerRequisitosComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_requisitos_comprobante",
    {
      title: "Requisitos para emitir un comprobante",
      description:
        "Dice QUÉ DATOS HACEN FALTA para emitir un tipo de CFE y cuál es la próxima pregunta a " +
        "hacerle al usuario. No emite nada ni llama a la API. Contempla las reglas de DGI: la " +
        "e-Factura exige receptor identificado siempre, y el e-Ticket lo exige por encima de " +
        "5.000 UI. Usala ANTES de biller_emitir_comprobante para no tener que adivinar el cuerpo.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Requisitos para emitir" },
    },
    async (args) => handleRequisitosComprobante(args, ctx),
  );
}
