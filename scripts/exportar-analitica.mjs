#!/usr/bin/env node
// =============================================================================
// Extracción analítica: la historia de la empresa, una vez, a un archivo.
//
// POR QUÉ EXISTE
//
// Las tools del MCP contestan preguntas de a una y en el momento. Eso es lo
// correcto para una conversación, y es insuficiente para mirar la serie: "¿cómo
// vengo mes a mes?", "¿este agosto contra el agosto pasado?", "¿tengo zafra?"
// son preguntas sobre TRES AÑOS de comprobantes, y traerlos cuesta ~53 ventanas
// por año. Pagarlo en cada pregunta es una funcionalidad que nadie usa.
//
// Esto lo paga UNA vez y deja el resultado en un archivo. No es el store local
// de `docs/STORE.md` —no hay SQLite, no hay sincronización incremental, no hay
// esquema versionado— y no pretende serlo: es el 20% que contesta las preguntas
// de serie temporal sin comprometer a nadie con una base de datos. Cuando el
// store exista, esto se borra.
//
// LA REGLA QUE LO HACE CONFIABLE: ACÁ NO SE CALCULA NADA DE PLATA.
//
// Todos los totales salen de `resumirFacturacion` y `AcumuladorUyu`, importados
// de `dist/` — las MISMAS funciones que contestan por WhatsApp y por MCP. Si
// este script sumara por su cuenta, tendríamos dos criterios de qué es una
// venta ("Aceptado DGI", el signo de las notas de crédito, los recibos que no
// se cuentan) y el tablero mostraría un número que el asistente contradice.
// Ese error ya pasó una vez en este repo, entre el resumen y los rankings, y
// costó unificar ocho implementaciones. Lo único que se calcula acá es el
// índice de zafralidad, que es aritmética sobre totales ya cerrados.
//
// SOLO GET, POR ESTRUCTURA. Igual que `contrato.mjs`: una sola función toca la
// red y tiene el método fijo en el literal.
//
// EL ARCHIVO QUE DEJA ES LA CONTABILIDAD DE LA EMPRESA. Se escribe 0600 y se
// dice en pantalla. No se sube a ningún lado: sale de tu API y queda en tu
// disco.
//
// USO
//   node --env-file=.env scripts/exportar-analitica.mjs
//   node --env-file=.env scripts/exportar-analitica.mjs --meses=36 --html
//
//   --meses=N      cuántos meses hacia atrás (default 24, máximo 60)
//   --out=RUTA     archivo JSON de salida (default ./analitica-<hoy>.json)
//   --html         además, un tablero HTML autocontenido al lado del JSON
//   --sucursal=ID  acota a una sucursal
// =============================================================================

import { chmodSync, writeFileSync } from "node:fs";
import { hoyIsoUy } from "../dist/services/fechaUy.js";
import { normalizeComprobantesEmitidos } from "../dist/biller/normalize.js";
import { resumirFacturacion } from "../dist/services/resumenFacturacion.js";
import { partirEnVentanas, rangoDeConsulta } from "../dist/services/periodo.js";
import { filterEmitidos } from "../dist/services/comprobanteFilters.js";

const BASE = (process.env.BILLER_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.BILLER_API_TOKEN ?? "").trim();

if (BASE === "" || TOKEN === "") {
  console.error("Faltan BILLER_API_BASE_URL o BILLER_API_TOKEN. Probá: node --env-file=.env scripts/exportar-analitica.mjs");
  process.exit(1);
}

function flag(nombre, porDefecto = null) {
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p === undefined ? porDefecto : p.slice(nombre.length + 3);
}
const tieneFlag = (n) => process.argv.includes(`--${n}`);

const MESES = Math.min(60, Math.max(1, Number(flag("meses", "24"))));
const SUCURSAL = flag("sucursal");
const hoy = hoyIsoUy();

// EL NOMBRE DEL ARCHIVO ES PARTE DE LA PROTECCIÓN, ASÍ QUE SE VALIDA.
//
// `.gitignore` protege por PATRÓN (`analitica-*.json`). Un `--out=./resumen.json`
// deja la contabilidad completa en la raíz del repo, sin ignorar, a un `git add
// -A` de distancia de quedar publicada. Exigir el patrón convierte esa
// protección de convención en estructura — es el mismo criterio con el que
// `contrato.mjs` fija el método GET en el literal en vez de prometerlo.
const destino = flag("out", `./analitica-${hoy}.json`);
const base = destino.split("/").pop() ?? "";
if (!/^analitica-[\w.-]*\.json$/.test(base)) {
  console.error(
    `El archivo tiene que llamarse "analitica-*.json" (recibí "${base}").\n` +
      "No es capricho: .gitignore ignora ese patrón, y este archivo es la contabilidad de la\n" +
      "empresa en claro. Con otro nombre queda sin ignorar dentro del repo.",
  );
  process.exit(1);
}


/** La ÚNICA función que toca la red, y el método está fijo en el literal. */
async function get(ruta, params = {}) {
  const url = new URL(BASE + ruta);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
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
  return { status: res.status, datos };
}

/** aaaa-mm del mes que está `n` meses antes del primero del mes de `iso`. */
function mesRelativo(iso, n) {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/** Último día del mes `aaaa-mm`. */
function finDeMes(mes) {
  const [a, m] = mes.split("-").map(Number);
  return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

const mesDesde = mesRelativo(hoy, -(MESES - 1));
const rango = { desde: `${mesDesde}-01`, hasta: hoy };

// El rango de CONSULTA no es el de la pregunta: la API filtra por fecha de
// CREACIÓN y la pregunta es por fecha de EMISIÓN. `rangoDeConsulta` agrega el
// margen; el recorte fino por emisión lo hace el agrupado de más abajo.
const consulta = rangoDeConsulta(rango);
const ventanas = partirEnVentanas(consulta);

console.error(`Extrayendo ${MESES} meses (${rango.desde} → ${rango.hasta}) en ${ventanas.length} ventanas…`);

// Concurrencia 4, igual que `traerVentanas`: el límite de la API es 30 req/s y
// saturar la cuenta rompería las otras integraciones de la empresa.
const CONCURRENCIA = 4;
const crudos = [];
const fallidas = [];
for (let i = 0; i < ventanas.length; i += CONCURRENCIA) {
  const lote = ventanas.slice(i, i + CONCURRENCIA);
  const res = await Promise.all(
    lote.map((v) => get("/v2/comprobantes/obtener", { desde: `${v.desde} 00:00:00`, hasta: `${v.hasta} 23:59:59`, sucursal: SUCURSAL ?? undefined })),
  );
  for (let j = 0; j < res.length; j += 1) {
    const r = res[j];
    if (r.status === 401 || r.status === 403) {
      console.error(`La API contestó ${r.status}: el token no sirve.`);
      process.exit(1);
    }
    if (r.status >= 400) {
      fallidas.push(`${lote[j].desde}→${lote[j].hasta} (HTTP ${r.status})`);
      continue;
    }
    const lista = Array.isArray(r.datos) ? r.datos : (r.datos?.comprobantes ?? []);
    crudos.push(...lista);
  }
  process.stderr.write(`\r  ${Math.min(i + CONCURRENCIA, ventanas.length)}/${ventanas.length} ventanas`);
}
process.stderr.write("\n");

// Deduplicación por id. Las ventanas se solapan en los bordes por el margen de
// creación, así que un comprobante puede venir dos veces.
const porId = new Map();
const sinId = [];
for (const c of normalizeComprobantesEmitidos(crudos)) {
  if (c.id === null) sinId.push(c);
  else porId.set(c.id, c);
}
const traidos = [...porId.values(), ...sinId];

// EL RECORTE POR FECHA DE EMISIÓN, Y POR QUÉ NO ES OPCIONAL.
//
// Lo que se pidió a la API es un rango de CREACIÓN más margen, y encima las
// ventanas están ancladas a una grilla global: lo que vuelve desborda el
// período por los dos lados. Sin recortar, el total del período incluía
// comprobantes que ningún mes de la serie contiene, y el tablero mostraba un
// total que no era la suma de sus barras. Dos números que no cierran entre sí
// es exactamente lo que este archivo no puede producir.
//
// El recorte lo hace `filterEmitidos`, que es el dueño de la regla — la misma
// que aplican las tools del MCP, incluido qué hacer con los que no traen fecha.
const recorte = filterEmitidos(traidos, { emitidas_desde: rango.desde, emitidas_hasta: rango.hasta });
const comprobantes = recorte.list;

// --- La serie: un `resumirFacturacion` por mes -------------------------------
//
// Por mes y no un `agrupar_por: ["mes"]` de una sola pasada porque el grupo no
// trae el equivalente en pesos ni los excluidos por estado, y esos dos son
// justamente lo que hace comparable un mes en dólares con uno en pesos.
const meses = [];
for (let i = 0; i < MESES; i += 1) {
  const mes = mesRelativo(rango.desde, i);
  const delMes = comprobantes.filter((c) => (c.fecha_emision ?? "").slice(0, 7) === mes);
  const r = resumirFacturacion(delMes, { incluir_anulados: false, solo_aceptados: true });
  meses.push({
    mes,
    desde: `${mes}-01`,
    hasta: finDeMes(mes),
    comprobantes: r.conteo_incluidos,
    totales_por_moneda: Object.fromEntries(Object.entries(r.totales_por_moneda).map(([m, v]) => [m, v.total])),
    equivalente_uyu: r.equivalente_uyu.total_uyu,
    cobertura_cambio_pct: r.equivalente_uyu.cobertura_pct,
    excluidos_por_estado: r.conteo_excluidos,
    conteo_por_estado: r.conteo_por_estado,
    clientes_distintos: new Set(
      delMes.map((c) => (typeof c.cliente === "object" && c.cliente !== null ? c.cliente.documento ?? null : null)).filter(Boolean),
    ).size,
  });
}

// --- Año contra año: el mismo mes del calendario, un año antes ---------------
for (const m of meses) {
  const anterior = meses.find((o) => o.mes === mesRelativo(`${m.mes}-01`, -12));
  m.anio_anterior =
    anterior === undefined
      ? null
      : {
          mes: anterior.mes,
          equivalente_uyu: anterior.equivalente_uyu,
          variacion_pct:
            anterior.equivalente_uyu === 0
              ? null
              : Math.round(((m.equivalente_uyu - anterior.equivalente_uyu) / anterior.equivalente_uyu) * 1000) / 10,
        };
}

// --- Zafralidad -------------------------------------------------------------
//
// Índice = promedio de ese mes del calendario / promedio de todos los meses.
// 1,0 es un mes normal; 1,4 es un mes 40% por encima del promedio.
//
// SOLO se calcula con DOS AÑOS COMPLETOS por mes. Con una sola observación por
// mes el "índice" es el mes mismo dividido por el promedio: no dice si hay
// zafra, dice que ese mes fue distinto, que es una obviedad disfrazada de
// análisis. Y el mes en curso, que está incompleto, no entra nunca.
const mesActual = hoy.slice(0, 7);
const cerrados = meses.filter((m) => m.mes !== mesActual && m.equivalente_uyu > 0);
const porMesCalendario = new Map();
for (const m of cerrados) {
  const mm = m.mes.slice(5, 7);
  if (!porMesCalendario.has(mm)) porMesCalendario.set(mm, []);
  porMesCalendario.get(mm).push(m.equivalente_uyu);
}
const promedioGeneral =
  cerrados.length === 0 ? 0 : cerrados.reduce((a, m) => a + m.equivalente_uyu, 0) / cerrados.length;
const observacionesMinimas = 2;
const zafralidadCalculable =
  promedioGeneral > 0 && [...porMesCalendario.values()].some((v) => v.length >= observacionesMinimas);

const zafralidad = !zafralidadCalculable
  ? {
      calculable: false,
      motivo:
        "Hacen falta al menos dos años cerrados para saber si un mes alto es zafra o fue un mes bueno. " +
        `Hoy hay ${cerrados.length} mes(es) con facturación. Volvé a correrlo con --meses=36 cuando tengas más historia.`,
      indices: {},
    }
  : {
      calculable: true,
      motivo: null,
      promedio_mensual_uyu: Math.round(promedioGeneral * 100) / 100,
      indices: Object.fromEntries(
        [...porMesCalendario.entries()]
          .filter(([, v]) => v.length >= observacionesMinimas)
          .map(([mm, v]) => [
            mm,
            {
              observaciones: v.length,
              promedio_uyu: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100,
              indice: Math.round((v.reduce((a, b) => a + b, 0) / v.length / promedioGeneral) * 100) / 100,
            },
          ]),
      ),
    };

// --- Cortes del período entero ----------------------------------------------
const total = resumirFacturacion(comprobantes, {
  incluir_anulados: false,
  solo_aceptados: true,
  agrupar_por: ["cliente"],
});
const porTipo = resumirFacturacion(comprobantes, {
  incluir_anulados: false,
  solo_aceptados: true,
  agrupar_por: ["tipo_comprobante"],
});

const nombrePorRut = new Map();
for (const c of comprobantes) {
  const cli = c.cliente;
  if (typeof cli === "object" && cli !== null && cli.documento) {
    nombrePorRut.set(String(cli.documento), cli.razon_social ?? cli.nombre_fantasia ?? null);
  }
}

const salida = {
  generado: new Date().toISOString(),
  ambiente: BASE.includes("test.") ? "test" : "production",
  rango: { ...rango, meses: MESES, criterio: "fecha_emision" },
  sucursal: SUCURSAL,
  criterio: {
    solo_aceptados: true,
    nota:
      'Los totales cuentan SOLO comprobantes "Aceptado DGI", que es el criterio con el que Biller ' +
      "arma los suyos. Los recibos de cobranza no suman (duplicarían la venta) y las notas de " +
      "crédito restan. Mismas funciones que contestan por MCP: si un número de acá no coincide " +
      "con el asistente, es un bug, no un criterio distinto.",
  },
  totales_periodo: {
    por_moneda: Object.fromEntries(Object.entries(total.totales_por_moneda).map(([m, v]) => [m, v.total])),
    equivalente_uyu: total.equivalente_uyu.total_uyu,
    comprobantes: total.conteo_incluidos,
    excluidos_por_estado: total.conteo_excluidos,
    conteo_por_estado: total.conteo_por_estado,
  },
  meses,
  zafralidad,
  clientes: total.grupos
    .map((g) => ({
      rut: g.clave.cliente,
      nombre: nombrePorRut.get(g.clave.cliente) ?? null,
      por_moneda: Object.fromEntries(Object.entries(g.totales_por_moneda).map(([m, v]) => [m, v.total])),
      comprobantes: g.conteo,
    }))
    .sort((a, b) => Math.max(...Object.values(b.por_moneda), 0) - Math.max(...Object.values(a.por_moneda), 0)),
  tipos_comprobante: porTipo.grupos.map((g) => ({ etiqueta: g.etiqueta, comprobantes: g.conteo })),
  cobertura: {
    ventanas_pedidas: ventanas.length,
    ventanas_fallidas: fallidas,
    completo: fallidas.length === 0,
  },
  warnings: [
    ...recorte.warnings,
    ...total.warnings,
    ...(fallidas.length > 0
      ? [
          `${fallidas.length} ventana(s) fallaron: ${fallidas.join(", ")}. La serie tiene huecos y los ` +
            "meses afectados están CORTOS. Volvé a correrlo antes de sacar conclusiones.",
        ]
      : []),
    "Los productos NO están acá: el detalle de ítems solo viene consultando comprobante por " +
      "comprobante (una request cada uno). Eso necesita el store local de docs/STORE.md.",
  ],
};

// EL INVARIANTE QUE SE VERIFICA ANTES DE ESCRIBIR NADA.
//
// El total del período tiene que ser exactamente la suma de los meses. Si no lo
// es, hay comprobantes que entran en un total y no en el otro, y el tablero
// muestra dos números que se contradicen — el modo de falla que ya costó
// unificar ocho implementaciones en este repo. Se avisa fuerte en vez de
// publicar un archivo que miente.
const sumaMeses = Math.round(salida.meses.reduce((a, m) => a + m.equivalente_uyu, 0) * 100) / 100;
const totalPeriodo = Math.round(salida.totales_periodo.equivalente_uyu * 100) / 100;
if (Math.abs(sumaMeses - totalPeriodo) > 0.05) {
  const aviso =
    `INCONSISTENCIA: el total del período ($ ${totalPeriodo}) no es la suma de los meses ` +
    `($ ${sumaMeses}). Hay comprobantes que entran en un total y no en el otro. NO uses estos ` +
    "números hasta entender por qué.";
  salida.warnings.unshift(aviso);
  console.error(`\n⚠ ${aviso}`);
}

writeFileSync(destino, `${JSON.stringify(salida, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(destino, 0o600);
console.error(`\n✓ ${destino} (0600 — es la contabilidad de la empresa)`);
console.error(`  ${comprobantes.length} comprobantes · ${meses.filter((m) => m.comprobantes > 0).length}/${MESES} meses con facturación`);
if (fallidas.length > 0) console.error(`  ⚠ ${fallidas.length} ventana(s) fallaron: la serie tiene huecos.`);

if (tieneFlag("html")) {
  const destinoHtml = destino.replace(/\.json$/, "") + ".html";
  writeFileSync(destinoHtml, tablero(salida), { encoding: "utf8", mode: 0o600 });
  chmodSync(destinoHtml, 0o600);
  console.error(`✓ ${destinoHtml} — abrilo en el navegador`);
}

// ---------------------------------------------------------------------------
// El tablero: HTML autocontenido, sin una sola request a ningún lado.
//
// Los datos van EMBEBIDOS en el archivo. No es una decisión estética: una
// página que hace fetch de la contabilidad es una página que necesita un
// servidor prendido y una URL, y ahí empieza a haber una superficie que
// proteger. Así es un archivo que se abre con doble clic y se borra cuando no
// se usa más.
// ---------------------------------------------------------------------------
function tablero(d) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const uy = (n) => new Intl.NumberFormat("es-UY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n ?? 0);
  const conDatos = d.meses.filter((m) => m.comprobantes > 0);
  const maxMes = Math.max(1, ...d.meses.map((m) => m.equivalente_uyu));

  const barras = d.meses
    .map((m) => {
      const alto = Math.round((m.equivalente_uyu / maxMes) * 100);
      const yoy = m.anio_anterior?.variacion_pct;
      const tit = `${m.mes}: $ ${uy(m.equivalente_uyu)} · ${m.comprobantes} comprobante(s)` + (yoy === null || yoy === undefined ? "" : ` · ${yoy > 0 ? "+" : ""}${yoy}% vs ${m.anio_anterior.mes}`);
      return `<div class="col" title="${esc(tit)}"><div class="barra" style="height:${alto}%"></div><span>${esc(m.mes.slice(2))}</span></div>`;
    })
    .join("");

  const filas = [...d.meses]
    .reverse()
    .filter((m) => m.comprobantes > 0)
    .map((m) => {
      const yoy = m.anio_anterior?.variacion_pct;
      const clase = yoy === null || yoy === undefined ? "" : yoy >= 0 ? "sube" : "baja";
      const txt = yoy === null || yoy === undefined ? "—" : `${yoy > 0 ? "+" : ""}${yoy}%`;
      const monedas = Object.entries(m.totales_por_moneda).map(([k, v]) => `${k} ${uy(v)}`).join(" · ") || "—";
      return `<tr><td>${esc(m.mes)}</td><td class="num">$ ${uy(m.equivalente_uyu)}</td><td>${esc(monedas)}</td><td class="num">${m.comprobantes}</td><td class="num ${clase}">${txt}</td></tr>`;
    })
    .join("");

  const NOMBRE_MES = { "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun", "07": "Jul", "08": "Ago", "09": "Set", "10": "Oct", "11": "Nov", "12": "Dic" };
  const zafra = d.zafralidad.calculable
    ? `<div class="zafra">${Object.entries(d.zafralidad.indices)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mm, v]) => {
          const cls = v.indice >= 1.15 ? "alto" : v.indice <= 0.85 ? "bajo" : "";
          return `<div class="z ${cls}" title="promedio $ ${uy(v.promedio_uyu)} · ${v.observaciones} año(s)"><b>${v.indice.toFixed(2)}</b><span>${NOMBRE_MES[mm] ?? mm}</span></div>`;
        })
        .join("")}</div>`
    : `<p class="aviso">${esc(d.zafralidad.motivo)}</p>`;

  const clientes = d.clientes
    .slice(0, 15)
    .map((c) => `<tr><td>${esc(c.nombre ?? c.rut)}</td><td class="mono">${esc(c.rut)}</td><td>${esc(Object.entries(c.por_moneda).map(([k, v]) => `${k} ${uy(v)}`).join(" · "))}</td><td class="num">${c.comprobantes}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Facturación ${esc(d.rango.desde)} → ${esc(d.rango.hasta)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1a1a18;--sec:#6b6b66;--linea:#e4e4e0;--card:#fff;--acento:#2f6f4f;--sube:#1f7a4d;--baja:#a13a2a;--barra:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececea;--sec:#9a9a94;--linea:#2c2c31;--card:#1e1e23;--acento:#6cc39a;--sube:#6cc39a;--baja:#e08b7a;--barra:#4e9d76}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:2.5rem 0 .75rem;letter-spacing:-.01em}
.sub{color:var(--sec);font-size:.875rem;margin:0 0 2rem}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.75rem}
.kpi{background:var(--card);border:1px solid var(--linea);border-radius:10px;padding:.9rem 1rem}
.kpi b{display:block;font-size:1.35rem;letter-spacing:-.02em}
.kpi span{color:var(--sec);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.grafico{display:flex;align-items:flex-end;gap:3px;height:190px;background:var(--card);border:1px solid var(--linea);border-radius:10px;padding:1rem .75rem .5rem;overflow-x:auto}
.col{flex:1 0 22px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:.35rem}
.barra{width:100%;background:var(--barra);border-radius:3px 3px 0 0;min-height:2px;transition:opacity .15s}
.col:hover .barra{opacity:.7}
.col span{font-size:.62rem;color:var(--sec);white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:.875rem;background:var(--card);border:1px solid var(--linea);border-radius:10px;overflow:hidden}
th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--sec);padding:.6rem .8rem;border-bottom:1px solid var(--linea)}
td{padding:.55rem .8rem;border-bottom:1px solid var(--linea)}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;color:var(--sec)}
.sube{color:var(--sube)}.baja{color:var(--baja)}
.zafra{display:grid;grid-template-columns:repeat(auto-fit,minmax(66px,1fr));gap:.5rem}
.z{background:var(--card);border:1px solid var(--linea);border-radius:8px;padding:.6rem .25rem;text-align:center}
.z b{display:block;font-size:1.05rem;font-variant-numeric:tabular-nums}
.z span{font-size:.7rem;color:var(--sec)}
.z.alto{border-color:var(--sube);color:var(--sube)}
.z.bajo{border-color:var(--baja);color:var(--baja)}
.aviso{background:var(--card);border:1px solid var(--linea);border-left:3px solid var(--sec);border-radius:8px;padding:.8rem 1rem;color:var(--sec);font-size:.86rem;margin:0}
.nota{color:var(--sec);font-size:.8rem;line-height:1.6;margin-top:.75rem}
.tabla-scroll{overflow-x:auto}
</style></head><body><div class="wrap">

<h1>Facturación</h1>
<p class="sub">${esc(d.rango.desde)} → ${esc(d.rango.hasta)} · por fecha de emisión · ambiente <b>${esc(d.ambiente)}</b> · generado ${esc(d.generado.slice(0, 16).replace("T", " "))}</p>

<div class="kpis">
  <div class="kpi"><span>Total del período</span><b>$ ${uy(d.totales_periodo.equivalente_uyu)}</b></div>
  <div class="kpi"><span>Comprobantes</span><b>${d.totales_periodo.comprobantes}</b></div>
  <div class="kpi"><span>Meses con ventas</span><b>${conDatos.length} / ${d.meses.length}</b></div>
  <div class="kpi"><span>Clientes</span><b>${d.clientes.length}</b></div>
</div>

<h2>Mes a mes</h2>
<div class="grafico">${barras}</div>
<p class="nota">Cada barra es el equivalente en pesos, convertido con la cotización declarada en cada comprobante — el criterio contable, no el valor de hoy. Pasá el mouse para ver el detalle.</p>

<h2>La serie, con el mismo mes del año anterior</h2>
<div class="tabla-scroll"><table><thead><tr><th>Mes</th><th class="num">Equivalente UYU</th><th>Por moneda</th><th class="num">Comprob.</th><th class="num">vs. año ant.</th></tr></thead><tbody>${filas}</tbody></table></div>

<h2>Zafralidad</h2>
${zafra}
${d.zafralidad.calculable ? '<p class="nota">Índice 1,00 = un mes promedio. Verde: 15% o más por encima. Rojo: 15% o más por debajo. Solo se calcula con dos años cerrados del mismo mes; el mes en curso nunca entra.</p>' : ""}

<h2>Clientes</h2>
<div class="tabla-scroll"><table><thead><tr><th>Cliente</th><th>RUT</th><th>Facturado</th><th class="num">Comprob.</th></tr></thead><tbody>${clientes}</tbody></table></div>

<h2>Qué NO dice este tablero</h2>
<p class="aviso">${d.warnings.map(esc).join("<br><br>")}</p>
<p class="nota">${esc(d.criterio.nota)}</p>

</div></body></html>`;
}
