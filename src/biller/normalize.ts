// =============================================================================
// Normalizadores: respuestas crudas de Biller -> modelos internos estables.
//
// Reglas defensivas (basadas en riesgos documentados):
//  - DGI devuelve objetos vacíos `{}` donde se espera un string -> null.
//  - Campos numéricos pueden venir como number o string -> number | null.
//  - `cliente` en emitidos viene como `[]` y su estructura NO está documentada
//    -> se preserva crudo (o null si está vacío); no se inventa forma.
// =============================================================================

import type {
  ComprobanteEmitido,
  ComprobanteRecibido,
  DgiActividad,
  DgiCertificado,
  DgiDatosEntidad,
  DgiNombreEntidad,
  RawComprobanteEmitido,
  RawComprobanteRecibido,
} from "./types.js";

// --- Coerciones genéricas ---------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Trata `{}`, `[]`, "" y null/undefined como null. DGI usa `{}` por "vacío". */
export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Objetos/arrays no son strings -> null (cubre el `{}` de DGI).
  return null;
}

export function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

/** Devuelve null para `[]` y `{}`; de lo contrario, el valor crudo. */
export function emptyToNull(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return null;
  return value;
}

// --- Comprobantes emitidos --------------------------------------------------

export function normalizeComprobanteEmitido(raw: unknown): ComprobanteEmitido {
  const r = raw as RawComprobanteEmitido;
  const rec = asRecord(raw);

  const normalized: ComprobanteEmitido = {
    id: toNumberOrNull(r.id),
    tipo_comprobante: toNumberOrNull(r.tipo_comprobante),
    serie: toStringOrNull(r.serie),
    numero: toNumberOrNull(r.numero),
    moneda: toStringOrNull(r.moneda),
    total: toNumberOrNull(r.total),
    indicador_cobranza_propia: toNumberOrNull(r.indicador_cobranza_propia),
    iva: {
      tasa_minima: toNumberOrNull(r.tot_iva_tasa_min),
      tasa_basica: toNumberOrNull(r.tot_iva_tasa_bas),
      tasa_otra: toNumberOrNull(r.tot_iva_tasa_otra),
    },
    descuentos_recargos: emptyToNull(r.descuentosRecargos),
    cliente: emptyToNull(r.cliente),
    es_nota_ajuste: toBooleanOrNull(r.esNotaAjuste),
    fecha_creacion: toStringOrNull(r.fecha_creacion),
    fecha_emision: toStringOrNull(r.fecha_emision),
    fecha_vencimiento: toStringOrNull(r.fecha_vencimiento),
    cae: emptyToNull(r.cae),
    campos_presentes: Object.keys(rec).sort(),
  };

  // `items` solo se incluye si Biller lo devolvió (consulta con `id`).
  if ("items" in rec) {
    normalized.items = emptyToNull(r.items);
  }

  return normalized;
}

export function normalizeComprobantesEmitidos(raw: unknown): ComprobanteEmitido[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return arr.map(normalizeComprobanteEmitido);
}

/**
 * Mejor esfuerzo para extraer un RUT del campo `cliente` (estructura NO
 * documentada). Devuelve null si no se puede determinar de forma confiable.
 */
export function extractClienteRut(cliente: unknown): string | null {
  const candidates = ["rut", "ruc", "RUT", "RUC", "documento", "rut_receptor", "doc"];
  const search = (obj: Record<string, unknown>): string | null => {
    for (const key of candidates) {
      if (key in obj) {
        const v = toStringOrNull(obj[key]);
        if (v) return v;
      }
    }
    return null;
  };
  if (cliente && typeof cliente === "object" && !Array.isArray(cliente)) {
    return search(cliente as Record<string, unknown>);
  }
  if (Array.isArray(cliente) && cliente.length > 0) {
    const first = cliente[0];
    if (first && typeof first === "object") {
      return search(first as Record<string, unknown>);
    }
  }
  return null;
}

// --- Comprobantes recibidos -------------------------------------------------

export function normalizeComprobanteRecibido(raw: unknown): ComprobanteRecibido {
  const r = raw as RawComprobanteRecibido;
  return {
    tipo: toNumberOrNull(r.tipo),
    serie: toStringOrNull(r.serie),
    numero: toNumberOrNull(r.numero),
    estado: toStringOrNull(r.estado),
    fecha: toStringOrNull(r.fecha),
    rut_emisor: toStringOrNull(r.rut_emisor),
    moneda: toStringOrNull(r.moneda),
    total_neto: toNumberOrNull(r.total_neto),
    total_iva: toNumberOrNull(r.total_iva),
    monto_total: toNumberOrNull(r.monto_total),
    total_retenido: toNumberOrNull(r.total_retenido),
  };
}

export function normalizeComprobantesRecibidos(raw: unknown): ComprobanteRecibido[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return arr.map(normalizeComprobanteRecibido);
}

// --- DGI --------------------------------------------------------------------

export function normalizeDgiNombreEntidad(raw: unknown): DgiNombreEntidad {
  const r = asRecord(raw);
  return {
    primer_nombre: toStringOrNull(r.PrimerNombre),
    segundo_nombre: toStringOrNull(r.SegundoNombre),
    primer_apellido: toStringOrNull(r.PrimerApellido),
    segundo_apellido: toStringOrNull(r.SegundoApellido),
    razon_social: toStringOrNull(r.RazonSocial),
  };
}

export function normalizeDgiDatosEntidad(raw: unknown): DgiDatosEntidad {
  const r = asRecord(raw);
  return {
    ruc: toStringOrNull(r.RUC),
    razon_social: toStringOrNull(r.RazonSocial),
    domicilio_fiscal_principal: emptyToNull(r.WS_DomicilioFiscalPrincipal),
  };
}

export function normalizeDgiActividad(raw: unknown): DgiActividad {
  const r = asRecord(raw);
  const actividades = extractActividades(r.WS_PersonaActividades);
  return {
    rut: toStringOrNull(r.RUT),
    denominacion: toStringOrNull(r.Denominacion),
    nombre_fantasia: toStringOrNull(r.NombreFantasia),
    tipo_entidad: toStringOrNull(r.TipoEntidad),
    descripcion_tipo_entidad: toStringOrNull(r.DescripcionTipoEntidad),
    estado_actividad: toStringOrNull(r.EstadoActividad),
    // Nota: el campo de DGI viene con el typo "FechaInicioActivdad".
    fecha_inicio_actividad: toStringOrNull(r.FechaInicioActivdad ?? r.FechaInicioActividad),
    actividades,
  };
}

function extractActividades(value: unknown): DgiActividad["actividades"] {
  const wrapper = asRecord(value);
  // DGI anida bajo "WS_PersonaActEmpresarial.WS_PersonaActividadesItem".
  const inner =
    wrapper["WS_PersonaActEmpresarial.WS_PersonaActividadesItem"] ?? Object.values(wrapper)[0];
  const list = Array.isArray(inner) ? inner : inner ? [inner] : [];
  return list.map((item) => {
    const it = asRecord(item);
    return {
      codigo: toStringOrNull(it.GiroCod),
      nombre: toStringOrNull(it.GiroNom),
      fecha_inicio: toStringOrNull(it.GiroFec_Ini),
    };
  });
}

export function normalizeDgiCertificado(raw: unknown): DgiCertificado {
  const r = asRecord(raw);
  return {
    flag: toStringOrNull(r.Flag),
    rut: toStringOrNull(r.RUT),
    certificado: emptyToNull(r.RespuestaOK),
  };
}
