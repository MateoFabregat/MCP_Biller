// Probe EXPLÍCITO de idempotencia contra el ambiente de test de Biller.
// El contrato normal (`contrato.mjs`) sigue siendo exclusivamente GET.

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE_TEST = "https://test.biller.uy";
const CONFIRMACION = "ENTIENDO_QUE_CREA_UN_CFE_DE_PRUEBA";

function requerido(env, nombre) {
  const valor = (env[nombre] ?? "").trim();
  if (valor === "") throw new Error(`Falta ${nombre}.`);
  return valor;
}

function validarBase(raw) {
  const normalizada = raw.replace(/\/+$/, "");
  if (normalizada !== BASE_TEST) {
    throw new Error(`El probe POST solo admite ${BASE_TEST}.`);
  }
  return normalizada;
}

function extraerLista(datos) {
  if (Array.isArray(datos)) return datos;
  if (datos !== null && typeof datos === "object") {
    if (Array.isArray(datos.comprobantes)) return datos.comprobantes;
    if (typeof datos.numero_interno === "string") return [datos];
  }
  return [];
}

async function jsonSeguro(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function ejecutarProbePost({
  env = process.env,
  fetchImpl = fetch,
  archivos = { readFile: (path) => readFileSync(path, "utf8"), stat: (path) => statSync(path) },
} = {}) {
  if ((env.BILLER_CONTRATO_POST_ENABLED ?? "").trim() !== "SI") {
    throw new Error("Probe POST deshabilitado: definí BILLER_CONTRATO_POST_ENABLED=SI.");
  }
  if ((env.BILLER_CONTRATO_POST_CONFIRM ?? "").trim() !== CONFIRMACION) {
    throw new Error(`Confirmación ausente: definí BILLER_CONTRATO_POST_CONFIRM=${CONFIRMACION}.`);
  }

  const baseUrl = validarBase(requerido(env, "BILLER_API_BASE_URL"));
  const token = requerido(env, "BILLER_API_TOKEN");
  const payloadPath = requerido(env, "BILLER_CONTRATO_POST_PAYLOAD_PATH");
  const executionId = requerido(env, "BILLER_CONTRATO_POST_EXECUTION_ID");
  const idempotencyKey = requerido(env, "BILLER_CONTRATO_POST_IDEMPOTENCY_KEY");
  if (idempotencyKey.length < 16) throw new Error("BILLER_CONTRATO_POST_IDEMPOTENCY_KEY es demasiado corta.");

  const metadata = archivos.stat(payloadPath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("El payload del probe debe tener permisos 0600.");
  }

  let payload;
  try {
    payload = JSON.parse(archivos.readFile(payloadPath));
  } catch {
    throw new Error("El payload del probe no es JSON válido.");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("El payload del probe debe ser un objeto JSON.");
  }
  if (payload.numero_interno !== executionId) {
    throw new Error("El numero_interno del payload debe coincidir con BILLER_CONTRATO_POST_EXECUTION_ID.");
  }

  const body = JSON.stringify(payload);
  const postOptions = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body,
  };
  const endpoint = `${baseUrl}/v2/comprobantes/crear`;
  const primero = await fetchImpl(endpoint, postOptions);
  if (!primero.ok) {
    throw new Error(`El primer POST falló con HTTP ${primero.status}; no se reintentó.`);
  }
  const segundo = await fetchImpl(endpoint, postOptions);

  const consulta = new URL(`${baseUrl}/v2/comprobantes/obtener`);
  consulta.searchParams.set("numero_interno", executionId);
  const evidencia = await fetchImpl(consulta.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!evidencia.ok) throw new Error(`No se pudo verificar el efecto por GET: HTTP ${evidencia.status}.`);

  const datos = await jsonSeguro(evidencia);
  const coincidencias = extraerLista(datos).filter(
    (comprobante) => comprobante?.numero_interno === executionId,
  ).length;
  if (coincidencias !== 1) {
    throw new Error(`La evidencia saneada encontró ${coincidencias} comprobantes para el identificador del probe.`);
  }

  return {
    statusPrimero: primero.status,
    statusSegundo: segundo.status,
    coincidencias,
  };
}

async function main() {
  const resultado = await ejecutarProbePost();
  console.log(
    `✓ Idempotencia verificada en test: POST ${resultado.statusPrimero}/${resultado.statusSegundo}; ` +
      `${resultado.coincidencias} comprobante para el identificador dedicado.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "El probe POST falló.");
    process.exitCode = 1;
  });
}

