// =============================================================================
// Certificado único de DGI: parseo del vencimiento y umbrales de aviso.
//
// Un certificado vencido corta la facturación de la empresa entera, así que la
// alerta la arma la tool `biller_alertas_operativas` — pero el I/O (la consulta
// GET /v2/dgi/empresas/certificado-unico) es lo ÚNICO que tiene que vivir allá.
// Leer una fecha de una respuesta de forma no documentada y decidir a partir de
// cuántos días se avisa son reglas de negocio, y viven acá.
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
// =============================================================================

import { CAE_DIAS_ADVERTENCIA, CAE_DIAS_CRITICO } from "./alertas.js";

/** Tope de profundidad para la búsqueda recursiva: evita recorrer estructuras gigantes o cíclicas. */
const CERTIFICADO_PROFUNDIDAD_MAXIMA = 4;

/** Nombres de campo candidatos a "fecha de vencimiento del certificado". */
const CAMPO_VENCIMIENTO_RE = /venc|expir|hasta|fin|valid/i;

/**
 * Reutiliza los umbrales del CAE: mismo tipo de urgencia (un corte de
 * facturación por vencimiento de una autorización), así que la misma
 * anticipación es razonable por defecto.
 */
export const CERTIFICADO_DIAS_CRITICO = CAE_DIAS_CRITICO;
export const CERTIFICADO_DIAS_ADVERTENCIA = CAE_DIAS_ADVERTENCIA;

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
