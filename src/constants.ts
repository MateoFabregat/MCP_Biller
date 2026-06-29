// Constantes globales del server MCP.

export const SERVER_NAME = "biller-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** OpenAPI público usado como fuente de verdad para endpoints y campos. */
export const OPENAPI_URL =
  "https://francodest-biller-v3-docs.apidocumentation.com/openapi.json";

// Paths GET documentados (únicos permitidos).
export const PATHS = {
  comprobantesObtener: "/v2/comprobantes/obtener",
  comprobantesRecibidos: "/v2/comprobantes/recibidos/obtener",
  dgiNombreEntidad: "/v2/dgi/empresas/nombre-entidad",
  dgiDatosEntidad: "/v2/dgi/empresas/datos-entidad",
  dgiActividad: "/v2/dgi/empresas/actividad-empresarial",
  dgiCertificado: "/v2/dgi/empresas/certificado-unico",
} as const;
