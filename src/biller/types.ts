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
  // Tipo de cambio del día para comprobantes en moneda extranjera (ej. USD).
  // La UI lo muestra como "Cotización: 38,397". En UYU llega como "1.000".
  tasa_cambio?: number | string | null;
  indicador_cobranza_propia?: number | string | null;
  tot_iva_tasa_min?: number | string | null;
  tot_iva_tasa_bas?: number | string | null;
  tot_iva_tasa_otra?: number | string | null;
  descuentosRecargos?: unknown;
  total?: number | string | null;
  cliente?: unknown;
  esNotaAjuste?: boolean | null;
  // Estado del CFE ante DGI. Valores reales observados: "Aceptado DGI",
  // "Rechazado DGI", "Sobre Rechazado DGI", "Pendiente DGI", "Envío no corresponde".
  // NO está documentado en el OpenAPI pero la API real SIEMPRE lo devuelve.
  estado?: string | null;
  // Sucursal emisora (ID real de Biller). La API lo devuelve en la respuesta.
  sucursal?: number | string | null;
  numero_interno?: string | null;
  // Flag 0/1: si los precios de los items incluyen IVA. NO es un objeto.
  montos_brutos?: number | string | boolean | null;
  adenda?: string | null;
  informacion_adicional?: string | null;
  numero_orden?: string | null;
  lugar_entrega?: string | null;
  clausula_venta?: string | null;
  modalidad_venta?: number | string | null;
  via_transporte?: number | string | null;
  tipo_traslado?: number | string | null;
  indicador_pagos_terceros?: boolean | number | string | null;
  // Referencia a otro CFE (notas de crédito/débito). Estructura variable.
  razon_referencia?: string | null;
  referencia_global?: unknown;
  retenciones_percepciones?: unknown;
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

/** Item del array `items` (presente al consultar con `id`). Campos reales de la API. */
export const ItemEmitidoSchema = z.object({
  id: z.number().nullable(),
  codigo: z.string().nullable(),
  codigo_ean: z.string().nullable(),
  codigo_dun: z.string().nullable(),
  cantidad: z.number().nullable(),
  concepto: z.string().nullable(),
  descripcion: z.string().nullable(),
  precio: z.number().nullable(),
  // 1=exento, 2=tasa mínima, 3=tasa básica, etc. (ver Tabla de Valores).
  indicador_facturacion: z.number().nullable(),
  // Tasa de IVA aplicada al ítem (ej. 0.22 = 22%).
  impuesto_tasa: z.number().nullable(),
  descuento_tipo: z.string().nullable(),
  descuento_cantidad: z.number().nullable(),
  recargo_tipo: z.string().nullable(),
  recargo_cantidad: z.number().nullable(),
  // "R"/"A" cuando hay retenciones; estructura variable -> crudo.
  indicador_agente_responsable: z.unknown().nullable(),
  retenciones_percepciones: z.unknown().nullable(),
  /** Campos del ítem no mapeados explícitamente (red de seguridad). */
  campos_extra: z.record(z.unknown()),
});
export type ItemEmitido = z.infer<typeof ItemEmitidoSchema>;

export const ComprobanteEmitidoSchema = z.object({
  id: z.number().nullable(),
  tipo_comprobante: z.number().nullable(),
  serie: z.string().nullable(),
  numero: z.number().nullable(),
  moneda: z.string().nullable(),
  // Cotización del día (comprobantes en moneda extranjera). null en UYU.
  tasa_cambio: z.number().nullable(),
  total: z.number().nullable(),
  indicador_cobranza_propia: z.number().nullable(),
  iva: IvaSchema,
  descuentos_recargos: z.unknown().nullable(),
  // La estructura real de `cliente` NO está documentada; en la práctica es un
  // objeto rico (id, tipo_documento, documento, razon_social, sucursal{...})
  // o `[]`/`"-"` cuando no hay receptor. Se preserva crudo.
  cliente: z.unknown().nullable(),
  es_nota_ajuste: z.boolean().nullable(),
  // Estado del CFE ante DGI (ej. "Aceptado DGI", "Rechazado DGI", "Pendiente DGI").
  estado: z.string().nullable(),
  // Sucursal emisora (ID real de Biller).
  sucursal: z.number().nullable(),
  numero_interno: z.string().nullable(),
  // Flag 0/1: si los precios de los items ya incluyen IVA.
  montos_brutos: z.number().nullable(),
  adenda: z.string().nullable(),
  informacion_adicional: z.string().nullable(),
  numero_orden: z.string().nullable(),
  lugar_entrega: z.string().nullable(),
  clausula_venta: z.string().nullable(),
  modalidad_venta: z.number().nullable(),
  via_transporte: z.number().nullable(),
  tipo_traslado: z.number().nullable(),
  indicador_pagos_terceros: z.boolean().nullable(),
  // Referencia a otro CFE (notas de crédito/débito). Estructura variable -> crudo.
  razon_referencia: z.string().nullable(),
  referencia_global: z.unknown().nullable(),
  retenciones_percepciones: z.unknown().nullable(),
  fecha_creacion: z.string().nullable(),
  fecha_emision: z.string().nullable(),
  fecha_vencimiento: z.string().nullable(),
  cae: z.unknown().nullable(),
  // Solo presente cuando Biller devuelve detalle (consulta con `id`).
  items: z.array(ItemEmitidoSchema).nullable().optional(),
  /** Claves crudas presentes en la respuesta (debug, sin secretos). */
  campos_presentes: z.array(z.string()),
  /**
   * Campos presentes en la respuesta cruda que el normalizador no mapea a una
   * clave tipada (p.ej. campos nuevos o no documentados). Se preservan tal cual
   * para no perder datos que el OpenAPI no declara.
   */
  campos_extra: z.record(z.unknown()),
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
