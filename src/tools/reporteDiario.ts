// =============================================================================
// biller_reporte_diario
//
// Arma el digest operativo (alertas + cobranzas + facturación) y opcionalmente
// lo manda por WhatsApp vía Kapso.
//
// EL ENVÍO ES OPT-IN Y CONFIRMADO. Por defecto esta tool solo DEVUELVE el
// texto: la acción irreversible —entregarle datos fiscales a un número de
// teléfono— requiere `enviar: true` Y un destinatario que esté en la allowlist.
//
// Por qué no alcanza con que el modelo "decida" mandarlo: el destinatario puede
// venir de un campo de texto de un comprobante (que escribe un tercero), de una
// alucinación, o de un dígito mal copiado. La allowlist es la que hace que
// ninguna de esas tres cosas termine en una fuga.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizarTelefono } from "../config.js";
import { KapsoClient } from "../kapso/client.js";
import { generarAlertas } from "../services/alertas.js";
import { compararPeriodos } from "../services/comparacion.js";
import { calcularCuentaCorriente } from "../services/cuentaCorriente.js";
import { construirDigest } from "../services/digest.js";
import { hoyComoDateUy } from "../services/fechaUy.js";
import { resolverPeriodo, aIso } from "../services/periodo.js";
import { rankingClientes } from "../services/rankingClientes.js";
import { resumirFacturacion } from "../services/resumenFacturacion.js";
import { detectarRiesgoPlata, type RiesgoPlataResultado } from "../services/riesgoPlata.js";
import { analizarVencimientos } from "../services/vencimientos.js";
import { traerVentanaAmplia } from "../services/ventana.js";
import { periodoAnterior } from "./compararPeriodos.js";
import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  enviar: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Si es true, ADEMÁS de devolver el texto lo envía por WhatsApp. Requiere Kapso configurado y " +
        "que el destinatario esté en la allowlist. Default: false (solo devuelve el texto).",
    ),
  destinatario: z
    .string()
    .optional()
    .describe(
      "Número de WhatsApp en formato internacional (ej. 59899123456). Obligatorio si enviar=true. " +
        "Debe estar en KAPSO_DESTINATARIOS_PERMITIDOS.",
    ),
  periodo_facturacion: z
    .string()
    .optional()
    .default("mes_actual")
    .describe("Período del total facturado que se incluye en el digest. Default: mes_actual."),
  dias_alertas: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .default(30)
    .describe("Cuántos días hacia atrás revisar en busca de rechazos DGI y problemas de CAE."),
  horizonte_vencimientos: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .default(7)
    .describe("Horizonte hacia adelante para los vencimientos, en días. Default: 7 (esta semana)."),
  incluir_plata_en_riesgo: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Incluye la sección 'plata en riesgo' (clientes en fuga, deudor grande, deuda por cruzar los " +
        "90 días, mes proyectando por debajo). Requiere mirar más historia, así que la consulta es " +
        "más larga: ponelo en false si querés el digest liviano.",
    ),
  dias_deuda: z
    .number()
    .int()
    .min(30)
    .max(1095)
    .optional()
    .default(365)
    .describe(
      "Ventana hacia atrás para la deuda vieja (default 365). Solo aplica si " +
        "incluir_plata_en_riesgo=true. Tiene que cubrir facturas Y cobros.",
    ),
  solo_si_hay_novedades: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Si es true y no hay nada que atender, NO envía el mensaje (igual devuelve el texto). " +
        "Sirve para el envío automático: un digest que llega todos los días sin novedad se deja de leer.",
    ),
};

export const reporteDiarioInputSchema = z.object(inputShape);

const outputShape = {
  texto: z.string(),
  requiere_atencion: z.boolean(),
  items_accionables: z.number(),
  secciones: z.array(z.string()),
  fecha: z.string(),
  envio: z.object({
    solicitado: z.boolean(),
    realizado: z.boolean(),
    motivo: z.string().nullable(),
    destinatario_sufijo: z.string().nullable(),
    message_id: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
};

export async function handleReporteDiario(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = reporteDiarioInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  if (a.enviar && (a.destinatario === undefined || a.destinatario.trim() === "")) {
    return simpleErrorResult(
      "Para enviar hace falta 'destinatario' (número de WhatsApp en formato internacional, ej. 59899123456).",
      ctx,
    );
  }

  try {
    const config = ctx.getConfig();
    // El digest arma DOS cosas con este `hoy`: los rangos que calcula acá y el
    // que le pasa a `resolverPeriodo`, que ya resolvía en hora uruguaya. Con
    // `new Date()` crudo, después de las 21:00 de Montevideo las dos mitades del
    // mismo mensaje quedaban en días distintos.
    const hoy = hoyComoDateUy();
    const fecha = aIso(hoy);
    const warnings: string[] = [];

    // --- Una sola consulta para todas las secciones -------------------------
    // Las tres miradas (alertas, facturación del período, plata en riesgo) se
    // superponen en el tiempo. Consultarlas por separado sería pagar dos o tres
    // veces por los mismos comprobantes: se pide el rango que las contiene a
    // todas y después se corta localmente por fecha de emisión.
    const rangoAlertas = {
      desde: aIso(new Date(hoy.getTime() - a.dias_alertas * 86_400_000)),
      hasta: fecha,
    };
    const rangoResumen = resolverPeriodo(a.periodo_facturacion, hoy);
    if (rangoResumen === null) {
      warnings.push(
        `No se pudo interpretar periodo_facturacion="${a.periodo_facturacion}": el digest va sin el total facturado.`,
      );
    }
    const rangoPrevio = rangoResumen !== null ? periodoAnterior(rangoResumen) : null;
    const rangoDeuda = a.incluir_plata_en_riesgo
      ? { desde: aIso(new Date(hoy.getTime() - a.dias_deuda * 86_400_000)), hasta: fecha }
      : null;

    const inicios = [rangoAlertas.desde, rangoResumen?.desde, rangoPrevio?.desde, rangoDeuda?.desde]
      .filter((d): d is string => d !== undefined && d !== null)
      .sort();
    const fines = [rangoAlertas.hasta, rangoResumen?.hasta, fecha]
      .filter((d): d is string => d !== undefined && d !== null)
      .sort();
    const rangoCompleto = { desde: inicios[0]!, hasta: fines[fines.length - 1]! };

    // `traerVentanaAmplia` porque acá el "período" son cuatro: recortar al
    // rango completo no filtraría nada y el warning hablaría de un período que
    // no es ninguno de ellos. La sucursal la resuelve el módulo (default de la
    // empresa), igual que en el resto de las tools.
    const ventana = await traerVentanaAmplia(ctx, { rango: rangoCompleto });
    const recorte = ventana.recorte;

    const emitidosAlertas = recorte(rangoAlertas);
    const alertas = generarAlertas(emitidosAlertas, { hoy });
    const vencimientos = analizarVencimientos(emitidosAlertas, {
      hoy,
      horizonte_dias: a.horizonte_vencimientos,
    });

    const resumen =
      rangoResumen === null
        ? undefined
        : resumirFacturacion(recorte(rangoResumen), { incluir_anulados: false });

    // --- Plata en riesgo ----------------------------------------------------
    let riesgo: RiesgoPlataResultado | undefined;
    if (a.incluir_plata_en_riesgo && rangoResumen !== null && rangoPrevio !== null) {
      const actuales = recorte(rangoResumen);
      const anteriores = recorte(rangoPrevio);
      riesgo = detectarRiesgoPlata({
        ranking_actual: rankingClientes(actuales, {
          desde: rangoResumen.desde,
          hasta: rangoResumen.hasta,
          limite: 100,
        }),
        ranking_previo: rankingClientes(anteriores, {
          desde: rangoPrevio.desde,
          hasta: rangoPrevio.hasta,
          limite: 100,
        }),
        cuenta:
          rangoDeuda === null ? undefined : calcularCuentaCorriente(recorte(rangoDeuda), { hoy }),
        comparacion: compararPeriodos(actuales, anteriores, rangoResumen, rangoPrevio, { hoy }),
      });
      warnings.push(...riesgo.warnings);
    }

    const digest = construirDigest({
      fecha,
      empresa: config.defaultEmpresaRut,
      alertas,
      riesgo,
      vencimientos,
      resumen,
      periodo_resumen: a.periodo_facturacion.replace(/_/g, " "),
    });

    // --- Envío (opt-in) -----------------------------------------------------
    let realizado = false;
    let motivo: string | null = null;
    let messageId: string | null = null;
    let sufijo: string | null = null;

    if (!a.enviar) {
      motivo = "No se solicitó envío (enviar=false).";
    } else if (config.kapso === undefined) {
      motivo =
        "Kapso no está configurado: falta KAPSO_API_KEY. El texto se devolvió igual, sin enviarse.";
      warnings.push(motivo);
    } else if (a.solo_si_hay_novedades && !digest.requiere_atencion) {
      motivo = "No hay novedades que atender y solo_si_hay_novedades=true: no se envió.";
    } else {
      const destino = normalizarTelefono(a.destinatario!);
      sufijo = destino.slice(-4);
      const kapso = new KapsoClient(config.kapso);
      const resultado = await kapso.enviar(destino, digest.texto);
      realizado = true;
      messageId = resultado.message_id;
      motivo = null;
    }

    return jsonResult({
      texto: digest.texto,
      requiere_atencion: digest.requiere_atencion,
      items_accionables: digest.items_accionables,
      secciones: digest.secciones,
      fecha,
      envio: {
        solicitado: a.enviar,
        realizado,
        motivo,
        destinatario_sufijo: sufijo,
        message_id: messageId,
      },
      warnings: [...warnings, ...alertas.warnings, ...vencimientos.warnings],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerReporteDiario(server: McpServer, ctx: ToolContext): void {
  const puedeEnviar = (() => {
    try {
      return ctx.getConfig().kapso !== undefined;
    } catch {
      return false;
    }
  })();

  server.registerTool(
    "biller_reporte_diario",
    {
      title: "Reporte diario operativo",
      description:
        "Arma el resumen del día listo para leer: lo urgente primero (rechazos DGI, CAE por " +
        "agotarse), después cobranzas vencidas y por vencer, y el total facturado del período. " +
        "Por defecto SOLO devuelve el texto. Con enviar=true lo manda por WhatsApp vía Kapso, " +
        "pero únicamente a números que estén en la allowlist configurada: este mensaje contiene " +
        "datos fiscales y no puede ir a un destinatario arbitrario.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      // Cuando el envío está disponible la tool deja de ser read-only: tiene un
      // efecto externo irreversible. Que la anotación lo diga permite al host
      // pedir confirmación.
      annotations: puedeEnviar
        ? { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Reporte diario operativo" }
        : { ...READ_ONLY_ANNOTATIONS, title: "Reporte diario operativo" },
    },
    async (args) => handleReporteDiario(args, ctx),
  );
}
