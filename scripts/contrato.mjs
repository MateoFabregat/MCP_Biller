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
import { clasificarEstado, ESTADO_ACEPTADO, ESTADO_ENVIO_NO_CORRESPONDE } from "../dist/services/estadoDgi.js";

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

/**
 * Una muestra reciente de comprobantes, en ventanas.
 *
 * NO es `{ fecha_desde, fecha_hasta }`: esos son los parámetros de
 * `/v2/comprobantes/recibidos/obtener`. `/v2/comprobantes/obtener` filtra con
 * `desde` y `hasta`, y los nombres que no conoce los IGNORA — así que la
 * consulta que este script hacía antes devolvía lo que la API quisiera darle
 * (en la práctica, nada). El chequeo de imputación de recibos venía diciendo
 * "no hay recibos en el ambiente" con la cuenta llena de recibos: un "sin
 * verificar" que parecía un dato del ambiente y era un bug del test.
 *
 * En ventanas porque la API no pagina y devuelve 500 con rangos amplios.
 */
async function muestraReciente(dias = 90) {
  const fin = new Date(`${hoy}T00:00:00Z`);
  const ventanas = [];
  for (let i = 0; i < Math.ceil(dias / 7); i += 1) {
    const hasta = new Date(fin.getTime() - i * 7 * 86400000);
    const desde = new Date(hasta.getTime() - 6 * 86400000);
    ventanas.push({ desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10) });
  }
  const porId = new Map();
  const sueltos = [];
  for (const v of ventanas) {
    const r = await get("/v2/comprobantes/obtener", {
      desde: `${v.desde} 00:00:00`,
      hasta: `${v.hasta} 23:59:59`,
    });
    if (r.status >= 400) continue;
    const lista = Array.isArray(r.datos) ? r.datos : (r.datos?.comprobantes ?? []);
    for (const c of lista) {
      if (c?.id === undefined || c?.id === null) sueltos.push(c);
      else porId.set(c.id, c);
    }
  }
  return [...porId.values(), ...sueltos];
}

// Se trae UNA vez y la comparten los chequeos que necesitan datos reales.
const MUESTRA = await muestraReciente();



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
  // 701/702/703 es la familia de recibos (e-Remito/Resguardo aparte). Ojo: un
  // recibo también puede venir como 101/111 con indicador_cobranza_propia=1.
  const recibo = MUESTRA.find(
    (c) =>
      [701, 702, 703].includes(Number(c?.tipo_comprobante)) ||
      Number(c?.indicador_cobranza_propia) === 1,
  );
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

// --- 5, 6 y 7. Los dos campos de los que depende TODO total de plata ---------
//
// POR QUÉ ESTOS DOS Y NO OTROS. `tasa_cambio` y `estado` no son dos campos más:
// son los únicos dos de los que depende que un número sea correcto o esté mal
// sin que nada falle.
//
//   · `estado` decide QUÉ SUMA. `clasificarEstado` normaliza mayúsculas y
//     tildes, así que "aceptado dgi" sigue contando; lo que NO sobrevive es un
//     texto DISTINTO ("Aceptado por DGI", "Autorizado"), que cae en
//     `desconocido` y por lo tanto no suma. Si la API renombrara ese estado,
//     todos los totales del proyecto se irían a CERO en silencio: sin
//     excepción, sin warning, sin un solo test rojo.
//   · `tasa_cambio` decide CUÁNTO VALE lo que está en dólares. Si dejara de
//     venir, el equivalente en pesos no se rompe: queda incompleto y avisa. Si
//     viniera como texto con coma decimal ("40,18"), `toNumberOrNull` daría
//     null y pasaría lo mismo pero para todos los comprobantes a la vez.
//
// Los 1593 tests usan fixtures —que es lo correcto para ellos— y por lo tanto
// ninguno puede ver este cambio. Esto sí.
{
  const lista = MUESTRA;

  if (lista.length === 0) {
    anotar("ojo", "tasa_cambio y estado: no hay comprobantes en el ambiente para verificarlos");
  } else {
    // --- 5. Los `estado` que devuelve la API siguen siendo los que conocemos --
    const estados = [...new Set(lista.map((c) => c?.estado).filter((e) => typeof e === "string" && e.trim() !== ""))];
    const desconocidos = estados.filter((e) => clasificarEstado(e) === "desconocido");
    anotar(
      desconocidos.length === 0 ? "ok" : "mal",
      `Los estados de la API siguen siendo los conocidos (${estados.length} distintos)`,
      desconocidos.length === 0
        ? `Vistos: ${estados.join(" · ")}`
        : `ESTADOS QUE NO RECONOCEMOS: ${desconocidos.join(" · ")}. Un estado desconocido NO SUMA en ` +
          "ningún total: si alguno de estos es en realidad una venta buena, los totales están cortos.",
    );

    // Las variantes de escritura NO son un fallo —`clasificarEstado` normaliza
    // mayúsculas y tildes— pero sí son una señal de que el texto se movió, y el
    // día que se mueva de verdad esto es lo que lo va a mostrar.
    const variantes = [
      ...new Set(
        lista
          .map((c) => c?.estado)
          .filter((e) => typeof e === "string" && clasificarEstado(e) === "aceptado" && e !== ESTADO_ACEPTADO),
      ),
    ];
    const aceptados = lista.filter((c) => c?.estado === ESTADO_ACEPTADO).length;
    anotar(
      variantes.length === 0 ? "ok" : "ojo",
      `El texto exacto "${ESTADO_ACEPTADO}" es el que llega (${aceptados} comprobantes)`,
      variantes.length === 0
        ? undefined
        : `Además llegan variantes de escritura: ${variantes.join(" · ")}. Hoy suman igual (la ` +
          "comparación normaliza mayúsculas y tildes), pero el texto se está moviendo.",
    );

    // --- 6. `tasa_cambio` sigue viniendo, y como número ---------------------
    const extranjera = lista.filter((c) => {
      const m = String(c?.moneda ?? "").trim().toUpperCase();
      return m !== "" && m !== "UYU" && m !== "858" && m !== "UY";
    });
    if (extranjera.length === 0) {
      anotar("ojo", "tasa_cambio: no hay comprobantes en moneda extranjera para verificarlo");
    } else {
      const sinTasa = extranjera.filter((c) => {
        const t = typeof c?.tasa_cambio === "string" ? Number(c.tasa_cambio) : c?.tasa_cambio;
        return typeof t !== "number" || !Number.isFinite(t) || t <= 0;
      });
      const tipos = [...new Set(extranjera.map((c) => typeof c?.tasa_cambio))];
      anotar(
        sinTasa.length === 0 ? "ok" : "mal",
        `tasa_cambio llega en los ${extranjera.length} comprobantes en moneda extranjera (tipo: ${tipos.join("/")})`,
        sinTasa.length === 0
          ? undefined
          : `${sinTasa.length} sin tasa usable. Esos comprobantes NO se convierten a pesos: el ` +
            "equivalente en UYU queda incompleto (lo avisa, pero el número queda corto).",
      );
      // Una coma decimal rompe `toNumberOrNull` y se lleva puestos TODOS.
      const conComa = extranjera.filter((c) => typeof c?.tasa_cambio === "string" && c.tasa_cambio.includes(","));
      if (conComa.length > 0) {
        anotar("mal", "tasa_cambio viene con COMA decimal", "Number() da NaN: ninguna factura en dólares se convierte.");
      }
    }

    // --- 7. Cuánto pesa "Envío no corresponde" (la medición del ticket T05) --
    //
    // LO QUE ESTE SCRIPT IMPRIME: agregados, nunca por comprobante. Un total por
    // moneda es el mismo número que el operador ve en su panel; una línea por
    // comprobante traería cliente y RUT a una terminal que puede terminar en un
    // log de CI. Si algún día se agrega un chequeo más, esa es la línea.
    //
    // No es un pass/fail: es el número que falta para decidir. Estos
    // comprobantes son ventas VÁLIDAS que hoy no suman en ningún total, porque
    // el criterio es "Aceptado DGI" a secas para coincidir con el panel de
    // Biller. Cambiar eso mueve todos los números del proyecto, así que la
    // decisión necesita saber cuánto es. Ver `esVentaValida` en estadoDgi.ts.
    const noCorresponde = lista.filter((c) => clasificarEstado(c?.estado) === "no_corresponde_enviar");
    if (noCorresponde.length === 0) {
      anotar("ojo", `Sin comprobantes en "${ESTADO_ENVIO_NO_CORRESPONDE}" en este ambiente`);
    } else {
      const porMoneda = {};
      for (const c of noCorresponde) {
        const m = String(c?.moneda ?? "?").trim().toUpperCase() || "?";
        const t = typeof c?.total === "string" ? Number(c.total) : c?.total;
        if (typeof t === "number" && Number.isFinite(t)) porMoneda[m] = (porMoneda[m] ?? 0) + t;
      }
      const detalle = Object.entries(porMoneda).map(([m, t]) => `${m} ${t.toFixed(2)}`).join(" · ");
      anotar(
        "ojo",
        `"${ESTADO_ENVIO_NO_CORRESPONDE}": ${noCorresponde.length} comprobante(s) fuera de los totales`,
        `Suman ${detalle}. Son ventas válidas que HOY no cuentan. Comparalo contra el panel de ` +
          "Biller: si Biller las muestra, el criterio de los totales está corto (ticket T05).",
      );
    }
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
