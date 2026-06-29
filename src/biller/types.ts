// =============================================================================
// Tipos crudos (mínimos, basados en los EJEMPLOS reales del OpenAPI) y
// schemas Zod de los modelos NORMALIZADOS que devuelven las tools.
//
// Fuente: https://francodest-biller-v3-docs.apidocumentation.com/openapi.json
//
// NOTA sobre los crudos: el OpenAPI declara estos responses como `object` /
// `text/plain` (schemas débiles). Por eso los "raw" se modelan laxos y la
// confianza está en los normalizadores + ejemplos documentados.
// =============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// Crudos (laxos a propósito)
// ---------------------------------------------------------------------------

/** Item del array devuelto por GET /v2/comprobantes/obtener (emitidos). */
export interface RawComprobanteEmitido {
  id?: number | string | null;
  tipo_comprobante?: number | string | null;
  serie?: string | null;
  numero?: number | string | null;
  moneda?: string | null;
  indicador_cobranza_propia?: number | string | null;
  tot_iva_tasa_min?: number | string | null;
  tot_iva_tasa_bas?: number | string | null;
  tot_iva_tasa_otra?: number | string | null;
  descuentosRecargos?: unknown;
  total?: number | string | null;
  cliente?: unknown;
  esNotaAjuste?: boolean | null;
  fecha_creacion?: string | null;
  fecha_emision?: string | null;
  fecha_vencimiento?: string | null;
  cae?: unknown;
  // Presente solo cuando se consulta con `id` (según documentación).
  items?: unknown;
  [key: string]: unknown;
}

/** Item del array (en text/plain) de GET /v2/comprobantes/recibidos/obtener. */
export interface RawComprobanteRecibido {
  tipo?: number | string | null;
  serie?: string | null;
  numero?: number | string | null;
  estado?: string | null;
  fecha?: string | null;
  rut_emisor?: string | null;
  moneda?: string | null;
  total_neto?: number | string | null;
  total_iva?: number | string | null;
  monto_total?: number | string | null;
  total_retenido?: number | string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalizados (Zod) — usados como outputSchema de las tools
// ---------------------------------------------------------------------------

export const IvaSchema = z.object({
  tasa_minima: z.number().nullable(),
  tasa_basica: z.number().nullable(),
  tasa_otra: z.number().nullable(),
});

export const ComprobanteEmitidoSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  moneda: z.string().nullable(),
  total: z.number().nullable(),
  indicador_cobranza_propia: z.number().nullable(),
  iva: IvaSchema,
  descuentos_recargos: z.unknown().nullable(),
  // La estructura real de `cliente` NO está documentada (el ejemplo es []).
  cliente: z.unknown().nullable(),
  es_nota_ajuste: z.boolean().nullable(),
  fecha_creacion: z.string().nullable(),
  fecha_emision: z.string().nullable(),
  fecha_vencimiento: z.string().nullable(),
  cae: z.unknown().nullable(),
  // Solo presente cuando Biller devuelve detalle (consulta con `id`).
  items: z.unknown().nullable().optional(),
  /** Claves crudas presentes en la respuesta (debug, sin secretos). */
  campos_presentes: z.array(z.string()),
});
export type ComprobanteEmitido = z.infer<typeof ComprobanteEmitidoSchema>;

export const ComprobanteRecibidoSchema = z.object({
  tipo: z.number().nullable(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  estado: z.string().nullable(),
  fecha: z.string().nullable(),
  rut_emisor: z.string().nullable(),
  moneda: z.string().nullable(),
  total_neto: z.number().nullable(),
  total_iva: z.number().nullable(),
  monto_total: z.number().nullable(),
  total_retenido: z.number().nullable(),
});
export type ComprobanteRecibido = z.infer<typeof ComprobanteRecibidoSchema>;

// --- DGI ---

export const DgiNombreEntidadSchema = z.object({
  primer_nombre: z.string().nullable(),
  segundo_nombre: z.string().nullable(),
  primer_apellido: z.string().nullable(),
  segundo_apellido: z.string().nullable(),
  razon_social: z.string().nullable(),
});
export type DgiNombreEntidad = z.infer<typeof DgiNombreEntidadSchema>;

export const DgiDatosEntidadSchema = z.object({
  ruc: z.string().nullable(),
  razon_social: z.string().nullable(),
  domicilio_fiscal_principal: z.unknown().nullable(),
});
export type DgiDatosEntidad = z.infer<typeof DgiDatosEntidadSchema>;

export const DgiActividadSchema = z.object({
  rut: z.string().nullable(),
  denominacion: z.string().nullable(),
  nombre_fantasia: z.string().nullable(),
  tipo_entidad: z.string().nullable(),
  descripcion_tipo_entidad: z.string().nullable(),
  estado_actividad: z.string().nullable(),
  fecha_inicio_actividad: z.string().nullable(),
  actividades: z.array(
    z.object({
      codigo: z.string().nullable(),
      nombre: z.string().nullable(),
      fecha_inicio: z.string().nullable(),
    }),
  ),
});
export type DgiActividad = z.infer<typeof DgiActividadSchema>;

export const DgiCertificadoSchema = z.object({
  flag: z.string().nullable(),
  rut: z.string().nullable(),
  certificado: z.unknown().nullable(),
});
export type DgiCertificado = z.infer<typeof DgiCertificadoSchema>;
