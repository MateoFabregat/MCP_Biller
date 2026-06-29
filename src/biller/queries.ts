// =============================================================================
// Query builders: arman la llamada GET documentada + normalizan la respuesta.
// Compartidos por las tools de comprobantes y por el resumen de facturación.
//
// Solo se usan parámetros DOCUMENTADOS en el OpenAPI:
//   /v2/comprobantes/obtener            -> id, sucursal, desde, hasta,
//                                          tipo_comprobante, serie, numero,
//                                          numero_interno, recibidos
//   /v2/comprobantes/recibidos/obtener  -> fecha_desde, fecha_hasta
// =============================================================================

import { PATHS } from "../constants.js";
import type { BillerClient } from "./client.js";
import {
  normalizeComprobantesEmitidos,
  normalizeComprobantesRecibidos,
} from "./normalize.js";
import type { ComprobanteEmitido, ComprobanteRecibido } from "./types.js";

export interface EmitidosQuery {
  id?: string;
  sucursal?: string;
  desde?: string;
  hasta?: string;
  tipo_comprobante?: string;
  serie?: string;
  numero?: string;
  numero_interno?: string;
  recibidos?: boolean;
}

export async function fetchEmitidos(
  client: BillerClient,
  q: EmitidosQuery,
): Promise<ComprobanteEmitido[]> {
  const raw = await client.get({
    path: PATHS.comprobantesObtener,
    query: {
      id: q.id,
      sucursal: q.sucursal,
      desde: q.desde,
      hasta: q.hasta,
      tipo_comprobante: q.tipo_comprobante,
      serie: q.serie,
      numero: q.numero,
      numero_interno: q.numero_interno,
      // `recibidos` solo se envía cuando es true (documentado: "Por defecto false").
      recibidos: q.recibidos ? "1" : undefined,
    },
    rateLimitClass: "default",
  });
  return normalizeComprobantesEmitidos(raw);
}

export interface RecibidosQuery {
  fecha_desde: string;
  fecha_hasta: string;
}

export async function fetchRecibidos(
  client: BillerClient,
  q: RecibidosQuery,
): Promise<ComprobanteRecibido[]> {
  const raw = await client.get({
    path: PATHS.comprobantesRecibidos,
    query: { fecha_desde: q.fecha_desde, fecha_hasta: q.fecha_hasta },
    // DGI: límite documentado de 1 req/seg.
    rateLimitClass: "dgi",
  });
  return normalizeComprobantesRecibidos(raw);
}
