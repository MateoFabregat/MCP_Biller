// =============================================================================
// biller_plata_en_riesgo
//
// "¿Qué me está costando plata que no estoy mirando?"
//
// Cruza cosas que por separado ya se pueden consultar —ranking de clientes,
// cuenta corriente, comparación de períodos— y que nadie cruza. El valor está
// justamente ahí: quién factura más y quién debe más son dos consultas
// distintas, y el riesgo vive en la intersección.
//
// COSTO EN LLAMADAS. Los tres análisis necesitan comprobantes de rangos que se
// superponen (período actual, período anterior, y un año hacia atrás para la
// deuda). Se hace UNA sola consulta sobre el rango que los contiene a todos y
// después se corta localmente. Consultar tres veces sería 3x el costo por los
// mismos datos.
//
// ESTA TOOL NUNCA HACE EL N+1 de `biller_cuenta_corriente`. Aquella consulta
// cada recibo por `id` para leer a qué factura se imputó; acá se usa solo lo
// que ya vino en el listado, y si no alcanza se imputa FIFO. El saldo POR
// CLIENTE —que es lo que miran estas alertas— es exacto en ambos casos; lo que
// queda estimado es el saldo por factura individual, y la respuesta lo declara.
// Para la imputación exacta, factura por factura, está `biller_cuenta_corriente`.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compararPeriodos } from "../services/comparacion.js";
import { calcularCuentaCorriente } from "../services/cuentaCorriente.js";
import { hoyComoDateUy } from "../services/fechaUy.js";
import {
  PERIODOS_SOPORTADOS,
  aIso,
  periodoAnterior,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
import { rankingClientes } from "../services/rankingClientes.js";
import { detectarRiesgoPlata } from "../services/riesgoPlata.js";
import { traerVentanaAmplia } from "../services/ventana.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/** Ventana hacia atrás para la deuda. La plata vieja es la que más riesgo tiene. */
const DIAS_DEUDA_DEFAULT = 365;

const inputShape = {
  periodo: z
    .string()
    .optional()
    .default("mes_actual")
    .describe(
      `Período a analizar, por fecha de EMISIÓN. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "El período de comparación (para medir caídas contra la propia historia) se calcula solo.",
    ),
  dias_deuda: z
    .number()
    .int()
    .min(30)
    .max(1095)
    .optional()
    .default(DIAS_DEUDA_DEFAULT)
    .describe(
      `Ventana hacia atrás para la cuenta corriente (default ${DIAS_DEUDA_DEFAULT}). Tiene que ` +
        "cubrir facturas Y sus cobros: si entra la factura pero no el recibo, la deuda sale inflada.",
    ),
  incluir_deuda: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Incluir los cruces que dependen de la cuenta corriente (deudor grande, deuda vieja). " +
        "En false la consulta es más liviana pero se pierden las dos alertas de cobranza.",
    ),
  sucursal: z.string().optional().describe("Filtra la consulta a una sola sucursal (ID de Biller)."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const plataEnRiesgoInputSchema = z.object(inputShape);

const montoSchema = z.object({ moneda: z.string(), monto: z.number() });

const outputShape = {
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  criterio: z.literal("fecha_emision"),
  periodo: z.object({ desde: z.string(), hasta: z.string() }),
  periodo_comparado: z.object({ desde: z.string(), hasta: z.string() }),
  rango_deuda: z.object({ desde: z.string(), hasta: z.string() }).nullable(),
  hay_riesgo: z.boolean(),
  alertas: z.array(
    z.object({
      tipo: z.string(),
      severidad: z.enum(["critica", "advertencia", "info"]),
      titulo: z.string(),
      detalle: z.string(),
      accion: z.string(),
      monto_en_riesgo: z.array(montoSchema),
      datos: z.record(z.unknown()),
    }),
  ),
  conteo_por_severidad: z.record(z.number()),
  /** Qué cruces se evaluaron y cuáles no, con el motivo. */
  cobertura: z.array(
    z.object({ tipo: z.string(), evaluado: z.boolean(), motivo: z.string().nullable() }),
  ),
  comprobantes_analizados: z.number(),
  ventanas_consultadas: z.number(),
  warnings: z.array(z.string()),
  no_convertir_moneda: z.literal(true),
};

export async function handlePlataEnRiesgo(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = plataEnRiesgoInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  // `resolverPeriodo` ya convertía a día uruguayo por dentro, pero el mismo
  // `hoy` se usa más abajo para restar días a mano: si viene en UTC, el rango
  // del período y el de la deuda arrancan en días distintos.
  const hoy = hoyComoDateUy();
  const rango = resolverPeriodo(a.periodo, hoy);
  if (rango === null) {
    return simpleErrorResult(
      `No se pudo interpretar el período "${a.periodo}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
      ctx,
    );
  }
  const previo = periodoAnterior(rango);

  try {
    const rangoDeuda: RangoFechas | null = a.incluir_deuda
      ? { desde: aIso(new Date(hoy.getTime() - a.dias_deuda * 86_400_000)), hasta: rango.hasta }
      : null;
    const rangoCompleto: RangoFechas = {
      desde: [previo.desde, rangoDeuda?.desde ?? previo.desde].sort()[0]!,
      hasta: rango.hasta,
    };

    // UNA sola consulta sobre el rango que contiene a los tres análisis, y
    // después recortes locales. `traerVentanaAmplia` no recorta al rango
    // completo: acá el "período" son tres, y `recorte` es el que ubica cada uno.
    const ventana = await traerVentanaAmplia(ctx, {
      rango: rangoCompleto,
      sucursal: a.sucursal,
      ventana_dias: a.ventana_dias,
    });
    const warnings = [...ventana.warnings];
    const recorte = ventana.recorte;

    const actuales = recorte(rango);
    const anteriores = recorte(previo);

    const rankingActual = rankingClientes(actuales, {
      desde: rango.desde,
      hasta: rango.hasta,
      limite: 100,
    });
    const rankingPrevio = rankingClientes(anteriores, {
      desde: previo.desde,
      hasta: previo.hasta,
      limite: 100,
    });

    const cuenta =
      rangoDeuda === null
        ? undefined
        : // Sin llamadas extra: se usan las referencias que ya vinieron en el
          // listado (si vinieron) y si no, FIFO. Ver la nota de cabecera.
          calcularCuentaCorriente(recorte(rangoDeuda), { hoy });
    if (cuenta !== undefined) warnings.push(...cuenta.warnings);

    const comparacion = compararPeriodos(actuales, anteriores, rango, previo, { hoy });

    const riesgo = detectarRiesgoPlata({
      ranking_actual: rankingActual,
      ranking_previo: rankingPrevio,
      cuenta,
      comparacion,
    });

    return jsonResult({
      fuente: "biller:/v2/comprobantes/obtener",
      criterio: "fecha_emision",
      periodo: rango,
      periodo_comparado: previo,
      rango_deuda: rangoDeuda,
      hay_riesgo: riesgo.alertas.length > 0,
      alertas: riesgo.alertas,
      conteo_por_severidad: riesgo.conteo_por_severidad,
      cobertura: riesgo.cobertura,
      comprobantes_analizados: ventana.comprobantes.length,
      ventanas_consultadas: ventana.ventanas,
      warnings: [...warnings, ...riesgo.warnings],
      no_convertir_moneda: true,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerPlataEnRiesgo(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_plata_en_riesgo",
    {
      title: "Plata en riesgo",
      description:
        "Alertas sobre el dinero, no sobre el trámite: clientes buenos que dejaron de comprar, " +
        "el cliente que más te compra y encima paga tarde, deuda por cruzar los 90 días, " +
        "concentración que subió, el mes proyectando por debajo del anterior y devoluciones " +
        "disparadas. Cada alerta trae una acción concreta y la plata expuesta por moneda. " +
        "Si no hay nada que atender devuelve la lista vacía, a propósito.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Plata en riesgo" },
    },
    async (args) => handlePlataEnRiesgo(args, ctx),
  );
}
