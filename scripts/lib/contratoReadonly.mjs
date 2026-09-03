import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const HARNESS_VERSION = "1";
export const TEST_BASE_URL = "https://test.biller.uy";

export function assertTestBaseUrl(value) {
  const base = String(value ?? "").trim().replace(/\/+$/, "");
  if (base !== TEST_BASE_URL) {
    throw new Error(`El harness solo acepta exactamente ${TEST_BASE_URL}; recibió ${base || "(vacío)"}.`);
  }
  return base;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.comprobantes)) return value.comprobantes;
  return [];
}

/** Solo conserva hechos necesarios para las decisiones pendientes, nunca PII. */
export function sanitizarComprobante(value) {
  const source = value && typeof value === "object" ? value : {};
  const number = (key) => {
    const candidate = source[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  };
  const text = (key) => {
    const candidate = source[key];
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
  };
  return {
    id: number("id"), tipo_comprobante: number("tipo_comprobante"), estado: text("estado"),
    moneda: text("moneda"), total: number("total"),
    iva: number("iva") ?? number("total_iva") ?? number("importe_iva"),
  };
}

function evidenciaPagina(label, response) {
  const lista = asList(response);
  return {
    sonda: label,
    cantidad: lista.length,
    evidencia_disponible: lista.length > 0,
    comprobantes: lista.slice(0, 10).map(sanitizarComprobante),
  };
}

const CAMPOS_ERROR_PERMITIDOS = new Set(["numero", "serie", "numero_interno"]);

function evidenciaRespuesta(label, status, response) {
  if (status === 422 && Array.isArray(response)) {
    const campos = response
      .map((error) => error && typeof error === "object" ? error.field : null)
      .filter((field) => typeof field === "string")
      .map((field) => CAMPOS_ERROR_PERMITIDOS.has(field) ? field : "otro");
    const camposUnicos = [...new Set(campos)];
    const ternaIncompletaConfirmada =
      camposUnicos.includes("numero") && camposUnicos.includes("serie");
    return {
      sonda: label,
      http_status: status,
      evidencia_disponible: ternaIncompletaConfirmada,
      campos_error: camposUnicos,
    };
  }
  return { ...evidenciaPagina(label, response), http_status: status };
}

/** La única función autorizada a tocar la red: GET fijo, sin cuerpos. */
async function getJson(base, token, path, query, fetchImpl) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, {
    method: "GET", headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* La respuesta cruda nunca se conserva. */ }
  return { status: response.status, data };
}

export function defaultArtifactPath(now = new Date()) {
  return join(".biller", "contratos", `readonly-${now.toISOString().replace(/[:.]/g, "-")}.json`);
}

/** Crea 0600 antes de escribir el primer byte, en una ruta ignorada por Git. */
export function writeArtifact(path, artifact) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, `${JSON.stringify(artifact, null, 2)}\n`, undefined, "utf8"); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

export async function runReadonlyContract({
  env = process.env, fetchImpl = fetch, now = () => new Date(), write = writeArtifact,
  artifactPath = defaultArtifactPath(now()),
} = {}) {
  if (env.BILLER_CONTRATO_READONLY !== "1") return { skipped: true, reason: "BILLER_CONTRATO_READONLY=1 no fue definido." };
  const base = assertTestBaseUrl(env.BILLER_API_BASE_URL);
  const token = String(env.BILLER_API_TOKEN ?? "").trim();
  if (token === "") throw new Error("Falta BILLER_API_TOKEN para el harness read-only.");
  const hoy = now().toISOString().slice(0, 10);
  const requests = [
    ["paginacion_emitidos_pagina_1", "/v2/comprobantes/obtener", { desde: `${hoy} 00:00:00`, hasta: `${hoy} 23:59:59`, pagina: 1 }],
    ["paginacion_emitidos_pagina_2", "/v2/comprobantes/obtener", { desde: `${hoy} 00:00:00`, hasta: `${hoy} 23:59:59`, pagina: 2 }],
    ["tipo_sin_serie_numero_rechazado", "/v2/comprobantes/obtener", { desde: `${hoy} 00:00:00`, hasta: `${hoy} 23:59:59`, tipo_comprobante: 101 }],
    ["iva_numerico_recibidos", "/v2/comprobantes/recibidos/obtener", { fecha_desde: hoy, fecha_hasta: hoy }],
  ];
  const results = await Promise.all(requests.map(([, path, query]) => getJson(base, token, path, query, fetchImpl)));
  const sondas = results.map((result, index) =>
    evidenciaRespuesta(requests[index][0], result.status, result.data),
  );
  const emitidos = [...asList(results[0].data), ...asList(results[1].data)].map(sanitizarComprobante);
  const recibidos = asList(results[3].data).map(sanitizarComprobante);
  const artifact = {
    tipo: "evidencia_externa_pendiente_de_interpretacion", version_harness: HARNESS_VERSION,
    capturado_en: now().toISOString(), ambiente: "test.biller.uy",
    nota: "Observaciones externas: no modifican reglas fiscales ni reemplazan tests con mocks.",
    cobertura: {
      paginacion: results[0].status === 200 && results[1].status === 200 && emitidos.length > 0,
      estados: emitidos.some((comprobante) => comprobante.estado !== null),
      terna_incompleta:
        results[2].status === 422 && sondas[2].evidencia_disponible === true,
      iva_numerico_recibidos: recibidos.some((comprobante) => comprobante.iva !== null),
    },
    sondas,
  };
  write(artifactPath, artifact);
  return { skipped: false, artifactPath, artifact };
}
