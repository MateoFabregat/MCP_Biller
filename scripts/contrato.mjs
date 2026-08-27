// =============================================================================
// El test de contrato: ¿la API real sigue comportándose como creemos?
//
// POR QUÉ EXISTE. Hay siete comportamientos de la API de Biller que se
// descubrieron llamándola de verdad, y CUATRO de ellos contradicen al OpenAPI.
// Cada uno está codificado en algún módulo —la imputación exacta de un recibo,
// el anti-duplicado, el parseo del certificado, el filtrado local por tipo— y
// hasta hoy vivían solamente en documentación y en el comentario de quien los
// encontró.
//
// El problema de eso: si Biller cambia uno, nada falla acá. Los 1375 tests
// siguen pasando —usan fixtures, que es lo correcto para ellos— y lo que se
// rompe es un número en el teléfono de alguien, semanas después, sin que nadie
// relacione una cosa con la otra.
//
// Esto convierte "la API cambió" de sorpresa en falla reproducible. No
// reemplaza a los tests: los tests dicen que NUESTRO código hace lo que dice, y
// esto dice que la REALIDAD contra la que se escribió sigue siendo esa.
//
// SOLO GET, Y NO ES UNA PROMESA SINO UNA ESTRUCTURA. Todas las llamadas pasan
// por `get()`, que es la única función que toca la red y tiene el método fijo.
// Un test de contrato que emite es un test que nadie corre en producción, y un
// contrato que solo se verifica en test no verifica nada.
//
// USO
//   npm run contrato
//
// Corre contra lo que diga BILLER_API_BASE_URL. Los casos que dependen de datos
// que el ambiente puede no tener se saltean diciéndolo, nunca se dan por buenos.
// =============================================================================

import { hoyIsoUy } from "../dist/services/fechaUy.js";

const ESC = "";
const OK = `${ESC}[32m✓${ESC}[0m`;
const MAL = `${ESC}[31m✗${ESC}[0m`;
const OJO = `${ESC}[33m—${ESC}[0m`;

const BASE = (process.env.BILLER_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.BILLER_API_TOKEN ?? "").trim();

if (BASE === "" || TOKEN === "") {
  console.error("Faltan BILLER_API_BASE_URL o BILLER_API_TOKEN.");
  process.exit(1);
}

const resultados = [];
function anotar(estado, titulo, detalle) {
  resultados.push(estado);
  console.log(`  ${estado === "ok" ? OK : estado === "mal" ? MAL : OJO} ${titulo}`);
  if (detalle !== undefined) console.log(`      ${detalle}`);
}

/**
 * La ÚNICA función que toca la red, y el método está fijo en el literal.
 *
 * No es decorativo: es lo que hace que "este script no escribe" sea revisable
 * de un vistazo en vez de una promesa repartida por veinte llamadas.
 */
async function get(ruta, params = {}) {
  const url = new URL(BASE + ruta);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  });
  const crudo = await res.text();
  let datos = null;
  try {
    datos = JSON.parse(crudo);
  } catch {
    datos = null;
  }
  return { status: res.status, datos, crudo };
}

// `hoyIsoUy` y no `toISOString()`: HANDBOOK §4.6. Acá decide el rango de fechas
// que se le pide a la API, y de noche UTC ya está en mañana.
const hoy = hoyIsoUy();

console.log(`Contrato de la API de Biller — ${BASE}\n`);

// --- 3. Un numero_interno inexistente devuelve 422, no lista vacía -----------
//
// Es un 404 disfrazado, y es el que sostiene el anti-duplicado: sin tratarlo
// como "no existe", `buscarPorNumeroInterno` interpretaba el 422 como un error
// y tiraba un warning falso en CADA emisión correcta.
{
  const inexistente = `contrato-inexistente-${Date.now()}`;
  const r = await get("/v2/comprobantes/obtener", { numero_interno: inexistente });
  if (r.status === 422) {
    const msg = JSON.stringify(r.datos ?? r.crudo);
    const habla = /no existe|numero_interno/i.test(msg);
    anotar(
      habla ? "ok" : "mal",
      "Un numero_interno inexistente devuelve 422 (un 404 disfrazado)",
      habla ? undefined : `422, pero el mensaje cambió: ${msg.slice(0, 200)}`,
    );
  } else {
    anotar(
      "mal",
      "Un numero_interno inexistente devuelve 422",
      `Devolvió ${r.status}. Si ahora es 200 con lista vacía, el anti-duplicado ` +
        "puede estar leyendo mal y hay que revisar `buscarPorNumeroInterno`.",
    );
  }
}

// --- 7. Filtrar por tipo_comprobante sin serie+numero devuelve 422 -----------
//
// Por esto el filtrado por tipo se hace LOCAL: se trae el rango y se filtra acá.
// Si la API empezara a aceptarlo, ese trabajo local pasa a ser evitable.
{
  const r = await get("/v2/comprobantes/obtener", {
    tipo_comprobante: 101,
    fecha_desde: `${hoy.slice(0, 8)}01`,
    fecha_hasta: hoy,
  });
  if (r.status === 422) {
    anotar("ok", "Filtrar por tipo_comprobante sin serie+numero sigue dando 422");
  } else {
    anotar(
      "ojo",
      "Filtrar por tipo_comprobante sin serie+numero YA NO da 422",
      `Devolvió ${r.status}. Si ahora se puede filtrar por tipo en la API, el ` +
        "filtrado local de `comprobantesEmitidos` dejó de ser necesario.",
    );
  }
}

// --- 4 y 5. El certificado viene PLANO, sin la envoltura del OpenAPI ---------
{
  // Necesita `rut`. Se usa el de la propia empresa si está configurado, y si no
  // el RUC de prueba que el ambiente de test devuelve para cualquier consulta.
  const rut = (process.env.BILLER_DEFAULT_EMPRESA_RUT ?? "").trim() || "219999830019";
  const r = await get("/v2/dgi/empresas/certificado-unico", { rut });
  if (r.status !== 200 || r.datos === null) {
    anotar("ojo", "Certificado único: no se pudo leer", `HTTP ${r.status}`);
  } else {
    const plano = typeof r.datos === "object" && "RUT" in r.datos;
    const envuelto =
      typeof r.datos === "object" && ("Flag" in r.datos || "RespuestaOK" in r.datos);
    if (plano && !envuelto) {
      const estado = String(r.datos.Estado ?? "");
      anotar("ok", "El certificado llega PLANO, sin envoltura Flag/RespuestaOK", `Estado: "${estado}"`);
      // El tercer estado: sin certificado, las fechas vienen como whitespace.
      const venc = String(r.datos.Vencimiento ?? "");
      if (venc.trim() === "" && venc !== "") {
        anotar("ok", "Sin certificado, Vencimiento llega como whitespace puro (no vacío ni null)");
      }
    } else {
      anotar(
        "mal",
        "El certificado cambió de forma",
        `plano=${plano} envuelto=${envuelto}. Claves: ${Object.keys(r.datos).join(", ").slice(0, 200)}`,
      );
    }
  }
}

// --- 1. La imputación de un recibo viaja en items[].concepto ----------------
//
// Es lo que convirtió `biller_cuenta_corriente` de estimación FIFO a imputación
// exacta. Depende de que el ambiente tenga algún recibo: si no hay, se dice.
{
  const r = await get("/v2/comprobantes/obtener", {
    fecha_desde: "2020-01-01",
    fecha_hasta: hoy,
  });
  const lista = Array.isArray(r.datos) ? r.datos : (r.datos?.comprobantes ?? []);
  // 701/702/703 es la familia de recibos (e-Remito/Resguardo aparte).
  const recibo = lista.find((c) => [701, 702, 703].includes(Number(c?.tipo_comprobante)));
  if (recibo === undefined) {
    anotar("ojo", "Imputación de recibos: no hay ningún recibo en el ambiente para verificarlo");
  } else {
    const detalle = await get("/v2/comprobantes/obtener", { id: recibo.id });
    const items = detalle.datos?.items ?? detalle.datos?.[0]?.items ?? [];
    const conConcepto = items.some((i) => typeof i?.concepto === "string" && i.concepto !== "");
    anotar(
      conConcepto ? "ok" : "mal",
      "La imputación de un recibo viaja en items[].concepto",
      conConcepto ? undefined : "El recibo no trae conceptos: `cuenta_corriente` volvería a estimar FIFO.",
    );
  }
}

// --- Lo que NO se puede verificar sin escribir ------------------------------
//
// Se listan en vez de callarse: un contrato que solo muestra lo que sabe medir
// se lee como si midiera todo.
console.log("\n  Sin cubrir acá (requieren emitir, y esto es GET-only):");
console.log("      · Cancelar un recibo genera otro recibo con total NEGATIVO.");
console.log("      · cliente.sucursal.direccion y .ciudad son obligatorias al dar de alta emitiendo.");

const malos = resultados.filter((r) => r === "mal").length;
console.log(
  `\n${resultados.filter((r) => r === "ok").length} confirmados, ` +
    `${resultados.filter((r) => r === "ojo").length} sin verificar, ${malos} cambiaron.`,
);
process.exit(malos > 0 ? 1 : 0);
