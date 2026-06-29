// =============================================================================
// Fixtures basadas en los EJEMPLOS reales del OpenAPI público de Biller.
// Fuente: https://francodest-biller-v3-docs.apidocumentation.com/openapi.json
// =============================================================================

import { detectEnvironment, type BillerConfig } from "../src/config.js";

export const TEST_TOKEN = "test-token-SUPER-SECRETO-123";

export function makeConfig(overrides: Partial<BillerConfig> = {}): BillerConfig {
  const base = {
    apiBaseUrl: "https://test.biller.uy",
    apiToken: TEST_TOKEN,
    timeoutMs: 30_000,
    logLevel: "error",
    writeEnabled: false,
    allowProductionWrites: false,
    ...overrides,
  };
  return {
    ...base,
    environment: overrides.environment ?? detectEnvironment(base.apiBaseUrl),
  };
}

// --- GET /v2/comprobantes/obtener (emitidos) -------------------------------
export const EMITIDO_EXAMPLE = [
  {
    id: 53616,
    tipo_comprobante: 101,
    serie: "C",
    numero: 2069514,
    moneda: "UYU",
    indicador_cobranza_propia: 0,
    tot_iva_tasa_min: 0,
    tot_iva_tasa_bas: 44,
    tot_iva_tasa_otra: null,
    descuentosRecargos: null,
    total: 244,
    cliente: [],
    esNotaAjuste: false,
    fecha_creacion: "2019-10-15 15:10:39",
    fecha_emision: "2019-10-15",
    fecha_vencimiento: "2019-10-30",
    cae: {
      numero: "76747726",
      serie: "C",
      inicio: 1,
      fin: 1000000,
      fecha_expiracion: "2021-10-15",
    },
  },
];

// --- GET /v2/comprobantes/recibidos/obtener (text/plain con JSON dentro) ----
export const RECIBIDOS_EXAMPLE_TEXT = `[
 {
    "tipo": 111,
    "serie": "B",
    "numero": 129,
    "estado": "AE",
    "fecha": "2020-03-02",
    "rut_emisor": "217832560011",
    "moneda": "USD",
    "total_neto": 180,
    "total_iva": 39.6,
    "monto_total": 219.6,
    "total_retenido": 0
  },
  {
    "tipo": 111,
    "serie": "D",
    "numero": 327825,
    "estado": "AE",
    "fecha": "2020-04-19",
    "rut_emisor": "217832560011",
    "moneda": "UYU",
    "total_neto": 749,
    "total_iva": 164.78,
    "monto_total": 913.78,
    "total_retenido": 0
  }
]`;

export const RECIBIDOS_EXAMPLE = JSON.parse(RECIBIDOS_EXAMPLE_TEXT) as unknown[];

// --- DGI ---
export const DGI_NOMBRE_EXAMPLE = {
  PrimerNombre: {},
  SegundoNombre: {},
  PrimerApellido: {},
  SegundoApellido: {},
  RazonSocial: "ADMINISTRACION NACIONAL DE COMBUSTIBLES ALCOHOL Y PORTLAND",
};

export const DGI_DATOS_ENTIDAD_EXAMPLE = {
  RUC: "210475730011",
  RazonSocial: "ADMINISTRACION NACIONAL DE COMBUSTIBLES ALCOHOL Y PORTLAND",
  WS_DomicilioFiscalPrincipal: { Loc_Nom: "MONTEVIDEO" },
};
