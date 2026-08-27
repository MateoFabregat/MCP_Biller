// Constantes globales del server MCP.

export const SERVER_NAME = "biller-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** OpenAPI público usado como fuente de verdad para endpoints y campos. */
export const OPENAPI_URL =
  "https://francodest-biller-v3-docs.apidocumentation.com/openapi.json";

// Paths GET documentados (únicos permitidos en la capa de lectura).
export const PATHS = {
  comprobantesObtener: "/v2/comprobantes/obtener",
  comprobantesPdf: "/v2/comprobantes/pdf",
  comprobantesRecibidos: "/v2/comprobantes/recibidos/obtener",
  dgiNombreEntidad: "/v2/dgi/empresas/nombre-entidad",
  dgiDatosEntidad: "/v2/dgi/empresas/datos-entidad",
  dgiActividad: "/v2/dgi/empresas/actividad-empresarial",
  dgiCertificado: "/v2/dgi/empresas/certificado-unico",
} as const;

/**
 * Paths POST documentados. Los consumen las tools de `src/tools/write/`, que
 * ejecutan a través de la capa aislada `src/write/`.
 *
 * ⚠️ La emisión de CFE vive en **v3** (`/v3/comprobantes/emitir`). El endpoint
 * v2 `/v2/comprobantes/crear` quedó fuera de la especificación vigente; el resto
 * de las operaciones sigue en v2.
 */
export const WRITE_PATHS = {
  comprobantesEmitir: "/v3/comprobantes/emitir",
  comprobantesAnular: "/v2/comprobantes/anular",
  clientesCrear: "/v2/clientes/crear",
  productosCargar: "/v2/productos/cargar",
  recibosCrear: "/v2/recibos/crear",
  recibosCancelar: "/v2/recibos/cancelar",
  pagosCrear: "/v2/pagos/crear",
} as const;
