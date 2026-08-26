// =============================================================================
// biller_alertas_operativas
//
// Barrido de un período buscando lo que hay que atender ya:
//   - comprobantes rechazados o no aceptados por DGI (sin validez fiscal),
//   - CAEs por agotarse o por vencer (la facturación se corta cuando pasa),
//   - emisión tardía (fecha_creacion muy posterior a fecha_emision: riesgo de
//     haber declarado el CFE fuera de plazo ante DGI),
//   - racha anómala sin facturar (relativa al comportamiento propio del
//     período, no un umbral fijo),
//   - certificado único de DGI vencido o por vencer (corta la facturación de
//     la empresa entera).
//
// Las primeras cuatro salen de campos que la API YA devuelve en cada
// comprobante. La del certificado requiere una consulta HTTP aparte
// (GET /v2/dgi/empresas/certificado-unico) cuya respuesta REAL difiere de la
// que documenta el OpenAPI — ver el bloque del certificado más abajo.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchCertificadoDgi } from "../biller/queries.js";
import { CAE_DIAS_ADVERTENCIA, CAE_DIAS_CRITICO, generarAlertas, type Alerta } from "../services/alertas.js";
import { hoyIsoUy } from "../services/fechaUy.js";
import { PERIODOS_SOPORTADOS, aIso } from "../services/periodo.js";
import { diasEntre } from "../services/vencimientos.js";
import { resolverRango, traerVentana } from "../services/ventana.js";
import { toSafeError } from "../utils/errors.js";
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
    .default("ultimos_30_dias")
    .describe(
      `Período por fecha de EMISIÓN a revisar. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: ultimos_30_dias. Para el CAE conviene un período amplio (la estimación mejora).",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  severidad_minima: z
    .enum(["critica", "advertencia", "info"])
    .optional()
    .default("advertencia")
    .describe("Filtra las alertas devueltas. Default: advertencia (oculta las informativas)."),
  sucursal: z.string().optional().describe("Filtra la consulta a una sola sucursal (ID real de Biller)."),
  max_por_estado: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(20)
    .describe("Cuántos comprobantes de ejemplo devolver por cada estado/grupo con problema."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
  incluir_certificado: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Consulta GET /v2/dgi/empresas/certificado-unico y alerta si está vencido o por vencer (corta " +
        "la facturación de la empresa entera). Requiere BILLER_DEFAULT_EMPRESA_RUT configurado. " +
        "Si la consulta falla, no rompe el resto de las alertas. Default: true.",
    ),
};

export const alertasInputSchema = z.object(inputShape);

const severidadSchema = z.enum(["critica", "advertencia", "info"]);

const comprobanteProblemaSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  etiqueta_tipo: z.string(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  fecha_emision: z.string().nullable(),
  estado: z.string().nullable(),
  moneda: z.string().nullable(),
  total: z.number().nullable(),
  sucursal: z.number().nullable(),
});

const comprobanteEmisionTardiaSchema = comprobanteProblemaSchema.extend({
  fecha_creacion: z.string().nullable(),
  dias_de_atraso: z.number(),
});

const caeSerieSchema = z.object({
  tipo_comprobante: z.number().nullable(),
  etiqueta_tipo: z.string(),
  serie: z.string().nullable(),
  cae_numero: z.string().nullable(),
  inicio: z.number().nullable(),
  fin: z.number().nullable(),
  ultimo_numero_usado: z.number().nullable(),
  disponibles_estimados: z.number().nullable(),
  porcentaje_disponible: z.number().nullable(),
  fecha_expiracion: z.string().nullable(),
  dias_para_expirar: z.number().nullable(),
  severidad: severidadSchema,
  motivos: z.array(z.string()),
  comprobantes_en_periodo: z.number(),
});

const emisionTardiaGrupoSchema = z.object({
  severidad: severidadSchema,
  conteo: z.number(),
  comprobantes: z.array(comprobanteEmisionTardiaSchema),
});

const emisionTardiaSchema = z.object({
  por_severidad: z.array(emisionTardiaGrupoSchema),
  conteo_total: z.number(),
  conteo_emision_futura: z.number(),
});

const rachaSinFacturarSchema = z
  .object({
    dias_con_emision: z.number(),
    brecha_habitual_dias: z.number(),
    racha_actual_dias: z.number(),
    ultima_emision: z.string().nullable(),
    umbral_dias: z.number(),
    alerta: z.boolean(),
  })
  .nullable();

const vencimientoCertificadoSchema = z.object({
  fecha: z.string().nullable(),
  campo: z.string().nullable(),
  candidatos: z.array(z.string()),
});

const certificadoDgiSchema = z.object({
  consultado: z.boolean(),
  rut: z.string().nullable(),
  /** Texto de estado de DGI. "NO existe Certificado de Vigencia Anual" es un estado válido. */
  estado: z.string().nullable().optional(),
  vencimiento: vencimientoCertificadoSchema.nullable(),
  dias_para_expirar: z.number().nullable(),
  error: z.string().nullable(),
});

const alertaSchema = z.object({
  tipo: z.enum([
    "rechazo_dgi",
    "estado_pendiente",
    "cae_por_agotarse",
    "cae_por_vencer",
    "cae_vencido",
    "emision_tardia",
    "sin_facturar",
    "certificado_vencido",
    "certificado_por_vencer",
  ]),
  severidad: severidadSchema,
  titulo: z.string(),
  detalle: z.string(),
  cantidad: z.number(),
  datos: z.record(z.unknown()),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  alertas: z.array(alertaSchema),
  conteo_por_severidad: z.record(z.number()),
  rechazos: z.object({
    conteo_total: z.number(),
    por_estado: z.array(
      z.object({
        estado: z.string(),
        severidad: severidadSchema,
        conteo: z.number(),
        comprobantes: z.array(comprobanteProblemaSchema),
      }),
    ),
  }),
  cae: z.array(caeSerieSchema),
  emision_tardia: emisionTardiaSchema,
  racha_sin_facturar: rachaSinFacturarSchema,
  certificado_dgi: certificadoDgiSchema,
  comprobantes_analizados: z.number(),
  ventanas_consultadas: z.number(),
  severidad_minima: severidadSchema,
  warnings: z.array(z.string()),
};

const ORDEN: Record<"critica" | "advertencia" | "info", number> = {
  critica: 0,
  advertencia: 1,
  info: 2,
};

// --- Certificado único de DGI ------------------------------------------------
//
// FORMA REAL (verificada contra test.biller.uy el 2026-07-28):
//   { RUT, Denominacion, DomicilioFiscal, TipoContribuyente,
//     Estado: "NO existe Certificado de Vigencia Anual",
//     Emision: "\n\t\t\t\t\t", Vencimiento: "\n\t\t\t\t\t" }
//
// Tres cosas que se aprendieron ahí y que este código contempla:
//
//  1. La respuesta viene PLANA. El ejemplo del OpenAPI la muestra envuelta en
//     `RespuestaOK` con un `Flag`. `normalizeDgiCertificado` acepta las dos.
//  2. `Estado` es un TERCER estado además de vigente/vencido: "NO existe
//     Certificado de Vigencia Anual". Una empresa sin certificado no está
//     "vencida", está sin emitir, y es un problema distinto.
//  3. Cuando no hay certificado, las fechas llegan como whitespace puro. Un
//     parseo ingenuo las tomaría como dato.
//
// La búsqueda recursiva se conserva igual, como RED: si en producción DGI
// devuelve la forma envuelta, o renombra el campo, el mapeo explícito falla y
// el buscador genérico lo encuentra igual. Y si tampoco lo encuentra, se dice
// explícitamente y se devuelven los NOMBRES de campo vistos (nunca los valores)
// para completar el mapeo a mano. Un "no sé" honesto es mejor que un parseo
// optimista que dice "todo bien" sobre un certificado vencido.

/** Tope de profundidad para la búsqueda recursiva: evita recorrer estructuras gigantes o cíclicas. */
const CERTIFICADO_PROFUNDIDAD_MAXIMA = 4;

/** Nombres de campo candidatos a "fecha de vencimiento del certificado". */
const CAMPO_VENCIMIENTO_RE = /venc|expir|hasta|fin|valid/i;

export interface VencimientoCertificado {
  fecha: string | null;
  campo: string | null;
  /** Nombres de campo inspeccionados (sin valores) para completar el mapeo a mano si `fecha` es null. */
  candidatos: string[];
}

/** Lee una fecha "aaaa-mm-dd..." de un valor de tipo desconocido. null si no matchea ese formato. */
function extraerFechaDeValor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

export function extraerVencimientoCertificado(certificado: unknown): VencimientoCertificado {
  const candidatosSet = new Set<string>();

  function buscar(valor: unknown, profundidad: number): { fecha: string; campo: string } | null {
    if (profundidad > CERTIFICADO_PROFUNDIDAD_MAXIMA) return null;
    if (Array.isArray(valor)) {
      for (const item of valor) {
        const hallado = buscar(item, profundidad + 1);
        if (hallado) return hallado;
      }
      return null;
    }
    if (valor === null || typeof valor !== "object") return null;

    const rec = valor as Record<string, unknown>;
    // Primera pasada: campos directos de este nivel cuyo nombre matchea.
    for (const [key, v] of Object.entries(rec)) {
      candidatosSet.add(key);
      if (CAMPO_VENCIMIENTO_RE.test(key)) {
        const fecha = extraerFechaDeValor(v);
        if (fecha !== null) return { fecha, campo: key };
      }
    }
    // Segunda pasada: recursar en lo anidado (objetos/arrays) solo si no se
    // encontró nada directo, para no perder una fecha mal anidada.
    for (const [, v] of Object.entries(rec)) {
      if (v !== null && typeof v === "object") {
        const hallado = buscar(v, profundidad + 1);
        if (hallado) return hallado;
      }
    }
    return null;
  }

  const hallado = buscar(certificado, 0);
  return {
    fecha: hallado?.fecha ?? null,
    campo: hallado?.campo ?? null,
    candidatos: [...candidatosSet].sort(),
  };
}

interface CertificadoDgiResultado {
  /** true si se llegó a intentar la consulta (había RUT configurado). */
  consultado: boolean;
  rut: string | null;
  /** Texto de estado que devuelve DGI, tal cual. */
  estado?: string | null;
  vencimiento: VencimientoCertificado | null;
  dias_para_expirar: number | null;
  error: string | null;
}

/**
 * Reutiliza los umbrales del CAE: mismo tipo de urgencia (un corte de
 * facturación por vencimiento de una autorización), así que la misma
 * anticipación es razonable por defecto.
 */
const CERTIFICADO_DIAS_CRITICO = CAE_DIAS_CRITICO;
const CERTIFICADO_DIAS_ADVERTENCIA = CAE_DIAS_ADVERTENCIA;

async function evaluarCertificadoDgi(
  ctx: ToolContext,
  rutConfigurado: string | undefined,
): Promise<{ resultado: CertificadoDgiResultado; alerta: Alerta | null; warnings: string[] }> {
  const resultado: CertificadoDgiResultado = {
    consultado: false,
    rut: null,
    vencimiento: null,
    dias_para_expirar: null,
    error: null,
  };

  if (rutConfigurado === undefined) {
    return {
      resultado,
      alerta: null,
      warnings: [
        "No se consultó el certificado único de DGI: falta BILLER_DEFAULT_EMPRESA_RUT en la " +
          "configuración. Configurala para incluir esta alerta (o pasá incluir_certificado=false " +
          "para no verla en cada corrida).",
      ],
    };
  }

  resultado.rut = rutConfigurado;

  let raw;
  try {
    const client = ctx.getClient();
    raw = await fetchCertificadoDgi(client, { rut: rutConfigurado });
  } catch (err) {
    // Falla de red/4xx/5xx en ESTA consulta puntual no debe tirar abajo el
    // resto de las alertas: se avisa y se sigue.
    let secrets: Array<string | undefined> = [];
    try {
      secrets = [ctx.getConfig().apiToken];
    } catch {
      secrets = [];
    }
    const safe = toSafeError(err, secrets);
    resultado.error = safe.message;
    return {
      resultado,
      alerta: null,
      warnings: [
        `No se pudo consultar el certificado único de DGI (${safe.message}). Se continúa con el ` +
          "resto de las alertas, pero no se puede saber si el certificado está vigente.",
      ],
    };
  }

  resultado.consultado = true;
  resultado.estado = raw.estado;

  // Mapeo EXPLÍCITO primero (campo `Vencimiento`, verificado contra la API), y
  // la búsqueda genérica solo como red por si DGI cambia el nombre o envuelve
  // la respuesta. Al revés sería frágil: el buscador podría enganchar otro
  // campo con "fin" o "valid" en el nombre antes de llegar al correcto.
  const fechaExplicita = /^\d{4}-\d{2}-\d{2}/.test(raw.vencimiento?.trim() ?? "")
    ? raw.vencimiento!.trim().slice(0, 10)
    : null;
  const vencimiento: VencimientoCertificado =
    fechaExplicita !== null
      ? { fecha: fechaExplicita, campo: "Vencimiento", candidatos: [] }
      : extraerVencimientoCertificado(raw.certificado);
  resultado.vencimiento = vencimiento;

  // Estado "NO existe Certificado de Vigencia Anual": no es un certificado
  // vencido, es uno que nunca se emitió. Distinguirlo importa porque la acción
  // es distinta —hay que tramitarlo, no renovarlo— y porque un certificado
  // inexistente no tiene fecha que mirar.
  const sinCertificado = /no existe/i.test(raw.estado ?? "");
  if (sinCertificado) {
    return {
      resultado,
      alerta: {
        tipo: "certificado_vencido",
        severidad: "critica",
        titulo: "La empresa no tiene Certificado de Vigencia Anual de DGI",
        detalle:
          `DGI responde: "${raw.estado}". Sin certificado vigente no se puede operar con normalidad ` +
          "ante DGI. No es un vencimiento: es un certificado que no está emitido, así que hay que " +
          "tramitarlo, no renovarlo.",
        cantidad: 1,
        datos: {
          rut: raw.rut,
          estado: raw.estado,
          denominacion: raw.denominacion,
          tipo_contribuyente: raw.tipo_contribuyente,
        },
      },
      warnings: [],
    };
  }

  if (vencimiento.fecha === null) {
    return {
      resultado,
      alerta: null,
      warnings: [
        "No se pudo determinar la fecha de vencimiento del certificado único de DGI. " +
          `Estado informado por DGI: "${raw.estado ?? "(sin estado)"}". Ningún campo de la respuesta ` +
          "trajo una fecha utilizable. Campos inspeccionados: " +
          `${vencimiento.candidatos.length > 0 ? vencimiento.candidatos.join(", ") : "(ninguno)"}.`,
      ],
    };
  }

  // `hoyIsoUy` y no `aIso(new Date())`: los umbrales del certificado son días
  // enteros, y en UTC el conteo se corre uno después de las 21:00 de Montevideo.
  const dias = diasEntre(hoyIsoUy(), vencimiento.fecha);
  resultado.dias_para_expirar = dias;

  const vencido = dias < 0;
  const critico = dias <= CERTIFICADO_DIAS_CRITICO;
  const advertencia = dias <= CERTIFICADO_DIAS_ADVERTENCIA;

  if (!vencido && !advertencia) {
    return { resultado, alerta: null, warnings: [] };
  }

  const alerta: Alerta = {
    tipo: vencido ? "certificado_vencido" : "certificado_por_vencer",
    severidad: vencido || critico ? "critica" : "advertencia",
    titulo: vencido
      ? `El certificado único de DGI está vencido hace ${-dias} día(s)`
      : `El certificado único de DGI vence en ${dias} día(s)`,
    detalle:
      `Un certificado vencido corta la facturación de TODA la empresa (no solo un CAE puntual). ` +
      `Vencimiento detectado: ${vencimiento.fecha} (campo "${vencimiento.campo}").`,
    cantidad: 1,
    datos: { rut: rutConfigurado, vencimiento, dias_para_expirar: dias },
  };

  return { resultado, alerta, warnings: [] };
}

export async function handleAlertas(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = alertasInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  // desde/hasta explícitos tienen prioridad sobre el default de `periodo`.
  const resuelto = resolverRango({ periodo: a.periodo, desde: a.desde, hasta: a.hasta });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rango = resuelto.rango;

  try {
    const config = ctx.getConfig();

    const ventana = await traerVentana(ctx, {
      rango,
      sucursal: a.sucursal,
      ventana_dias: a.ventana_dias,
    });

    const resultado = generarAlertas(ventana.comprobantes, { max_por_estado: a.max_por_estado });

    let certificado: CertificadoDgiResultado = {
      consultado: false,
      rut: null,
      vencimiento: null,
      dias_para_expirar: null,
      error: null,
    };
    let warningsCertificado: string[] = [];
    let todasLasAlertas = resultado.alertas;
    // Se recalcula si el certificado agrega una alerta (ver más abajo): el
    // conteo tiene que reflejar TODAS las alertas devueltas, no solo las que
    // ya calculó `generarAlertas` antes de conocer el estado del certificado.
    let conteoPorSeveridad = resultado.conteo_por_severidad;

    if (a.incluir_certificado) {
      const { resultado: certResultado, alerta, warnings } = await evaluarCertificadoDgi(
        ctx,
        config.defaultEmpresaRut,
      );
      certificado = certResultado;
      warningsCertificado = warnings;
      if (alerta !== null) {
        todasLasAlertas = [...resultado.alertas, alerta].sort(
          (x, y) => ORDEN[x.severidad] - ORDEN[y.severidad] || y.cantidad - x.cantidad,
        );
        conteoPorSeveridad = {
          ...resultado.conteo_por_severidad,
          [alerta.severidad]: (resultado.conteo_por_severidad[alerta.severidad] ?? 0) + 1,
        };
      }
    }

    const umbral = ORDEN[a.severidad_minima];
    const alertas = todasLasAlertas.filter((al) => ORDEN[al.severidad] <= umbral);

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      fuente: "biller:/v2/comprobantes/obtener",
      alertas,
      conteo_por_severidad: conteoPorSeveridad,
      rechazos: resultado.rechazos,
      cae: resultado.cae,
      emision_tardia: resultado.emision_tardia,
      racha_sin_facturar: resultado.racha_sin_facturar,
      certificado_dgi: certificado,
      comprobantes_analizados: resultado.comprobantes_analizados,
      ventanas_consultadas: ventana.ventanas,
      severidad_minima: a.severidad_minima,
      warnings: [...ventana.warnings, ...resultado.warnings, ...warningsCertificado],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerAlertas(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_alertas_operativas",
    {
      title: "Alertas operativas",
      description:
        "Revisa un período y devuelve lo que hay que atender: comprobantes rechazados o pendientes " +
        "ante DGI (sin validez fiscal), CAEs por agotarse o por vencer, emisión tardía (riesgo de CFE " +
        "declarado fuera de plazo), rachas anómalas sin facturar y — opcionalmente — el certificado " +
        "único de DGI vencido o por vencer (corta la facturación de toda la empresa). " +
        "Los números de CAE disponibles son una estimación optimista: solo se ve el período consultado.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Alertas operativas" },
    },
    async (args) => handleAlertas(args, ctx),
  );
}
