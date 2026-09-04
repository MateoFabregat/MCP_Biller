#!/usr/bin/env node
// =============================================================================
// Dar de alta una empresa, verificando contra la API REAL.
//
// POR QUÉ EXISTE
//
// Poner una empresa nueva son ~25 variables de entorno, y varias no fallan al
// arrancar sino MUCHO después:
//
//   · `BILLER_DEFAULT_SUCURSAL_ID` mal (el clásico "1" en vez del id real, 347)
//     arranca perfecto y devuelve 422 recién al emitir — con el cliente esperando.
//   · Un número de la allowlist con el 0 nacional adentro (598095923567) no
//     coincide nunca, y el envío se rechaza sin decir por qué.
//   · El valor de la UI se vence y nadie se entera hasta que un e-Ticket grande
//     sale sin receptor identificado.
//
// `biller_health_check` dice si la configuración está COMPLETA. Esto dice si
// está BIEN, que no es lo mismo: lo único que distingue una de otra es llamar a
// la API de verdad. Es la misma lección que ya dejó escrita la doc del proyecto
// —cuatro de siete comportamientos verificados contradicen al OpenAPI— aplicada
// al alta de un cliente nuevo.
//
// USO
//
//   node scripts/onboard.mjs                 # la empresa del .env del proceso
//   node scripts/onboard.mjs --tenant=panaderia   # una del registro multi-empresa
//                                                 # (requiere `npm run build`: el
//                                                 # entorno del tenant lo arma el
//                                                 # mismo código que el server)
//   node scripts/onboard.mjs --json          # salida para un pipeline
//
//   node scripts/onboard.mjs --crear --nombre="Panadería Rivera"
//       # ALTA de una empresa nueva: pregunta el token y el ambiente, deriva el
//       # RUT y la sucursal de la propia API, genera la credencial de entrada,
//       # la escribe en BILLER_TENANTS_PATH (0600) validando el registro ENTERO
//       # con el validador real ANTES de tocar el disco, y verifica el alta
//       # contra la API. Flags para pipelines: --token= --ambiente= --sucursal=
//       # --id= --registro= --max-uyu= --max-usd=
//       # Las barreras humanas (allowlists, capability mode, escritura) NO se
//       # autocompletan jamás: quedan listadas como pendientes.
//
// En modo verificación NO ESCRIBE NADA (solo GET). En modo --crear escribe UNA
// cosa: la entrada nueva en el archivo del registro, y solo si el registro
// resultante valida entero.
// =============================================================================

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const modoJson = args.includes("--json");
const modoCrear = args.includes("--crear");
const flag = (nombre) => (args.find((a) => a.startsWith(`--${nombre}=`)) ?? "").split("=").slice(1).join("=") || null;
let tenantPedido = flag("tenant");

// --- Entorno efectivo (con overlay del tenant si se pidió uno) --------------

/**
 * El armado del entorno de un tenant NO se reimplementa acá.
 *
 * Este script tenía su propio `{ ...env, ...tenant.env }`, que es la mitad de lo
 * que hace el registro real y justo la mitad inofensiva. Lo que faltaba:
 *
 *   · el BORRADO de lo que un tenant no hereda (las `KAPSO_*`, la allowlist de
 *     remitentes, los flags de escritura, la identidad fiscal). Con el spread
 *     propio, esas variables del proceso se colaban en el entorno mostrado, así
 *     que el operador leía "1 teléfono autorizado" o "Kapso configurado" cuando
 *     el server real iba a arrancar sin ninguna de las dos. Un alta que parece
 *     aislada y no lo está es peor que un alta que falla.
 *   · las validaciones FATALES: `BILLER_API_TOKEN` repetido entre tenants, rutas
 *     de persistencia repetidas, y las rutas o los topes que el proceso define y
 *     el tenant no declara. El script daba el visto bueno a un registro con el
 *     que el server no arranca.
 *
 * Pasando por `construirRegistro`/`entornoDe`, lo que se verifica contra la API
 * es exactamente lo que el server va a usar, y un registro que no arranca falla
 * acá — en el alta, que es cuando todavía es barato.
 *
 * Se importa de `dist/` como el resto de los scripts: el módulo es TypeScript y
 * no hay forma de leerlo sin compilar. Sin `dist` se dice qué correr, en vez de
 * caer en un `ERR_MODULE_NOT_FOUND` que no explica nada.
 */
async function cargarRegistroTenants() {
  try {
    return await import("../dist/tenants/registry.js");
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    fatal(
      "Para verificar una empresa del registro multi-empresa hace falta el build " +
        "(el armado del entorno de un tenant se lee de `src/tenants/registry.ts`, no se " +
        "reimplementa acá). Corré `npm run build` y volvé a intentar.",
    );
  }
}

async function cargarEnv() {
  let env = { ...process.env };

  // .env no se parsea con dependencias: cuatro líneas alcanzan y este script
  // tiene que poder correr en una máquina recién clonada.
  try {
    for (const linea of readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linea);
      if (m && env[m[1]] === undefined) {
        env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* sin .env: se usan solo las del proceso */
  }

  if (tenantPedido === null) return { env, tenant: null };

  const inline = (env.BILLER_TENANTS_JSON ?? "").trim();
  const ruta = (env.BILLER_TENANTS_PATH ?? "").trim();
  if (inline === "" && ruta === "") {
    fatal(
      `Pediste --tenant=${tenantPedido} pero no hay registro de empresas ` +
        "(ni BILLER_TENANTS_JSON ni BILLER_TENANTS_PATH).",
    );
  }
  let crudo;
  try {
    crudo = JSON.parse(inline !== "" ? inline : readFileSync(ruta, "utf8"));
  } catch (err) {
    fatal(`El registro de empresas no es JSON válido: ${err instanceof Error ? err.message : err}`);
  }

  const { construirRegistro, entornoDe } = await cargarRegistroTenants();

  // Se valida el registro ENTERO, no solo la entrada pedida, porque así lo valida
  // el server: un token de Biller duplicado o dos empresas apuntando al mismo
  // archivo de audit son errores de la LISTA, y no arrancan aunque la empresa que
  // estás dando de alta esté impecable.
  let registro;
  try {
    registro = construirRegistro(crudo, env);
  } catch (err) {
    fatal(
      `El registro de empresas no arranca, así que este alta no se puede verificar:\n      ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const tenant = registro.tenants.find((t) => t.id === tenantPedido);
  if (tenant === undefined) {
    fatal(
      `No hay ninguna empresa con id "${tenantPedido}". Las que hay: ` +
        registro.tenants.map((t) => t.id).join(", "),
    );
  }
  // El MISMO entorno que le va a llegar a `loadConfig` cuando entre una request
  // con el `auth_token` de esta empresa: con los borrados aplicados, no un merge
  // parecido.
  return { env: entornoDe(tenant, env), tenant };
}

function fatal(mensaje) {
  console.error(`✗ ${mensaje}`);
  process.exit(2);
}

// --- Los chequeos -----------------------------------------------------------

const resultados = [];

function anotar(estado, titulo, detalle) {
  resultados.push({ estado, titulo, detalle });
}

const ok = (t, d) => anotar("ok", t, d);
const falta = (t, d) => anotar("falta", t, d);
const aviso = (t, d) => anotar("aviso", t, d);

async function get(env, path, query = {}) {
  const url = new URL(path, env.BILLER_API_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.BILLER_API_TOKEN}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    cuerpo = texto.slice(0, 400);
  }
  return { status: res.status, cuerpo };
}

/** aaaa-mm-dd de hace `dias` días. */
function haceDias(dias) {
  const d = new Date(Date.now() - dias * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// --- El modo --crear: dar de alta escribiendo, no solo verificando ----------
//
// EL PRINCIPIO QUE ORDENA QUÉ SE AUTOMATIZA: se deriva lo que sale de un hecho
// verificable (el RUT y las sucursales vienen en los comprobantes que la API ya
// devuelve con el token). NO se automatiza ninguna barrera: capability mode,
// flags de escritura, topes de monto y las dos allowlists de teléfonos quedan
// vacíos a propósito — un alta que los rellena sola es un alta que le regala a
// una empresa nueva el permiso de emitir en producción. Es el mismo criterio de
// VARIABLES_QUE_NO_SE_HEREDAN, un nivel más arriba.
//
// Y la regla del null honesto: si de 90 días salen TRES sucursales, no se elige
// la más frecuente — se listan y se pregunta. Ante la duda no se elige.

/** Preguntas por stdin con cola de líneas (mismo patrón que cli/init: no pierde
 *  respuestas que llegan por pipe, y EOF corta con error en vez de colgarse). */
function crearPreguntador() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
  const cola = [];
  const esperas = [];
  let cerrado = false;
  rl.on("line", (l) => (esperas.length > 0 ? esperas.shift()(l) : cola.push(l)));
  rl.on("close", () => {
    cerrado = true;
    for (const e of esperas.splice(0)) e(null);
  });
  return {
    cerrar: () => rl.close(),
    pregunta: async (texto) => {
      process.stderr.write(texto);
      const enCola = cola.shift();
      if (enCola !== undefined) {
        process.stderr.write("\n");
        return enCola;
      }
      if (cerrado) fatal("Se terminó la entrada antes de responder todas las preguntas.");
      const linea = await new Promise((res) => esperas.push(res));
      if (linea === null) fatal("Se terminó la entrada antes de responder todas las preguntas.");
      return linea;
    },
  };
}

/** "Panadería Rivera S.R.L." -> "panaderia-rivera-srl" (el charset que exige el registro). */
function slug(nombre) {
  const s = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? null : s;
}

async function crear() {
  // El .env del proceso se lee igual que en el modo verificación: de ahí salen
  // BILLER_TENANTS_PATH y el entorno base sobre el que se aplica el overlay.
  const { env: envBase } = await cargarEnv();
  const preguntador = crearPreguntador();
  const { pregunta } = preguntador;

  process.stderr.write("Alta de una empresa nueva en el registro multi-empresa.\n\n");

  // 1. Nombre, ambiente y token (flags para pipelines, preguntas para humanos).
  let nombre = flag("nombre");
  while (!nombre || slug(nombre) === null) {
    nombre = (await pregunta("Nombre de la empresa (como lo conoce el operador): ")).trim();
  }
  const id = flag("id") ?? slug(nombre);

  let ambiente = flag("ambiente");
  if (ambiente !== "test" && ambiente !== "produccion") {
    const r = (await pregunta("¿Ambiente? [1] test (recomendado)  [2] producción: ")).trim();
    ambiente = r === "2" ? "produccion" : "test";
  }
  const baseUrl = ambiente === "produccion" ? "https://biller.uy" : "https://test.biller.uy";

  let apiToken = flag("token");
  while (!apiToken) {
    apiToken = (await pregunta(`Token de la API de Biller de ${nombre} (${baseUrl}): `)).trim();
  }

  // 2. Sondar la API con ESE token: de acá salen el RUT y las sucursales que
  //    hasta hoy se copiaban a mano (y se copiaban mal: el clásico sucursal=1).
  const envSonda = { BILLER_API_BASE_URL: baseUrl, BILLER_API_TOKEN: apiToken };
  process.stderr.write("\nSondeando la API de Biller (90 días de comprobantes, solo lectura)…\n");
  const sonda = await get(envSonda, "/v2/comprobantes/obtener", {
    fecha_desde: `${haceDias(90)} 00:00:00`,
    fecha_hasta: `${haceDias(0)} 23:59:59`,
  });
  if (sonda.status === 401 || sonda.status === 403) {
    fatal(`La API contestó ${sonda.status}: el token no sirve. Revisalo en ${baseUrl}/api/tokens.`);
  }
  if (sonda.status >= 400) {
    process.stderr.write(
      `! La sonda contestó ${sonda.status} (con rangos grandes Biller devuelve 500 en vez de paginar): ` +
        "el RUT y la sucursal no se derivan esta vez, se pueden agregar después.\n",
    );
  }
  const comprobantes = Array.isArray(sonda.cuerpo) ? sonda.cuerpo : [];

  const ruts = [...new Set(comprobantes.map((c) => String(c.rut_emisor ?? "").trim()).filter(Boolean))];
  const sucursales = [...new Set(comprobantes.map((c) => String(c.sucursal ?? "").trim()).filter(Boolean))];

  // El RUT: un token es de UNA empresa, así que más de un rut_emisor sería un
  // dato roto — se avisa y no se elige.
  let rut = null;
  if (ruts.length === 1) rut = ruts[0];
  else if (ruts.length > 1) {
    process.stderr.write(`! La API devolvió ${ruts.length} RUT emisores distintos (${ruts.join(", ")}): no se configura ninguno.\n`);
  } else {
    process.stderr.write("! Sin comprobantes en 90 días: el RUT no se puede derivar (se puede agregar después).\n");
  }

  // La sucursal: una → default; varias → SE PREGUNTA; cero → null honesto.
  let sucursal = flag("sucursal");
  if (sucursal === null) {
    if (sucursales.length === 1) {
      sucursal = sucursales[0];
      process.stderr.write(`✓ Una sola sucursal en 90 días: ${sucursal}. Queda como default.\n`);
    } else if (sucursales.length > 1) {
      const r = (
        await pregunta(
          `La empresa facturó desde ${sucursales.length} sucursales (${sucursales.join(", ")}). ` +
            "¿Cuál es la principal? (el ID, o Enter para no fijar ninguna): ",
        )
      ).trim();
      sucursal = r === "" ? null : r;
    }
  }

  // 2b. Los topes de monto: si el proceso los define, el registro EXIGE que cada
  //     empresa declare el suyo (heredar aplica el número de otro; borrar deja
  //     sin freno). No se autocompleta: se PREGUNTA, que es lo que el diseño
  //     pide — el operador elige, explícito y por empresa.
  const topesProceso = Object.keys(envBase).filter(
    (k) => k.startsWith("BILLER_MAX_MONTO_") && (envBase[k] ?? "").trim() !== "",
  );
  const topes = {};
  if (topesProceso.length > 0) {
    for (const clave of topesProceso) {
      const moneda = clave.slice("BILLER_MAX_MONTO_".length);
      let valor = flag(`max-${moneda.toLowerCase()}`);
      while (valor === null || !/^[0-9]+$/.test(valor)) {
        valor = (
          await pregunta(
            `Tope máximo por emisión en ${moneda} para ${nombre} ` +
              `(el proceso usa ${envBase[clave]}; escribí el número, sin puntos): `,
          )
        ).trim();
      }
      topes[clave] = valor;
    }
  }

  // 3. Credencial de entrada al MCP: generada, no inventada por un humano.
  const authToken = randomBytes(32).toString("hex");

  // 4. La entrada del registro. Las cuatro barreras humanas NO van: quedan como
  //    la lista de pendientes que se imprime al final.
  const entrada = {
    id,
    nombre,
    auth_token: authToken,
    env: {
      BILLER_API_TOKEN: apiToken,
      BILLER_API_BASE_URL: baseUrl,
      ...(rut !== null ? { BILLER_DEFAULT_EMPRESA_RUT: rut } : {}),
      ...(sucursal !== null && sucursal !== undefined ? { BILLER_DEFAULT_SUCURSAL_ID: sucursal } : {}),
      ...topes,
    },
  };

  // 5. Al ARCHIVO, nunca al JSON inline: registry.ts ya explica por qué (un JSON
  //    con veinte tokens dentro de una variable termina copiado con uno de menos).
  const rutaRegistro = flag("registro") ?? ((envBase.BILLER_TENANTS_PATH ?? "").trim() || null);
  if (!rutaRegistro) {
    fatal(
      "No sé DÓNDE escribir el registro: configurá BILLER_TENANTS_PATH (o pasá --registro=ruta). " +
        "El registro va en un archivo, no en BILLER_TENANTS_JSON inline.",
    );
  }
  let existentes = [];
  if (existsSync(rutaRegistro)) {
    try {
      existentes = JSON.parse(readFileSync(rutaRegistro, "utf8"));
    } catch (err) {
      fatal(`El registro existente (${rutaRegistro}) no es JSON válido: ${err.message}. No lo piso.`);
    }
    if (!Array.isArray(existentes)) fatal(`El registro existente (${rutaRegistro}) no es un array. No lo piso.`);
  }
  const candidato = [...existentes, entrada];

  // 6. Validar el registro ENTERO con el validador REAL antes de escribir una
  //    letra: token de Biller repetido, id repetido, archivos compartidos — todo
  //    lo que haría que el server no arranque falla ACÁ, con el disco intacto.
  const { construirRegistro, entornoDe } = await cargarRegistroTenants();
  let registro;
  try {
    registro = construirRegistro(candidato, envBase);
  } catch (err) {
    fatal(`El alta dejaría un registro con el que el server NO arranca:\n      ${err.message}`);
  }

  // Escribir y RELEER: lo que se verifica es lo que quedó en el disco.
  writeFileSync(rutaRegistro, `${JSON.stringify(candidato, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // El `mode` de writeFileSync solo aplica al CREAR el archivo: si ya existía
  // —un alta anterior, o el archivo creado a mano antes de correr esto—, el
  // permiso previo sobrevive a la escritura. Este archivo tiene el token de
  // Biller y el auth_token de cada empresa: se fuerza 0600 después de escribir.
  chmodSync(rutaRegistro, 0o600);
  const releido = construirRegistro(JSON.parse(readFileSync(rutaRegistro, "utf8")), envBase);
  const tenant = releido.tenants.find((t) => t.id === id);

  process.stderr.write(
    `\n✓ Empresa "${nombre}" agregada a ${rutaRegistro} (id: ${id}).\n\n` +
      "CREDENCIAL DE ENTRADA (se muestra UNA vez; es lo que va en el cliente MCP como Bearer):\n\n" +
      `  ${authToken}\n\n` +
      "QUEDA PENDIENTE, A MANO Y A CONCIENCIA (ninguna barrera se autocompleta):\n" +
      "  · BILLER_REMITENTES_AUTORIZADOS / KAPSO_* — quién puede preguntar y el canal de WhatsApp\n" +
      "  · BILLER_CAPABILITY_MODE / BILLER_WRITE_ENABLED / BILLER_APPROVAL_SECRET — hoy queda en solo lectura\n" +
      (Object.keys(topes).length === 0 ? "  · BILLER_MAX_MONTO_UYU / _USD — topes de emisión\n" : "") +
      "  · BILLER_VALOR_UI + _FECHA — el umbral de 5.000 UI\n\n" +
      "Verificando el alta contra la API real…\n",
  );

  preguntador.cerrar();
  // La verificación usa el MISMO entorno que va a usar el server: overlay real.
  return { env: entornoDe(tenant, envBase), nombre: tenant.nombre };
}

async function main() {
  if (modoCrear) {
    const creado = await crear();
    return await verificar(creado.env, creado.nombre);
  }
  const { env, tenant } = await cargarEnv();
  const nombre = tenant?.nombre ?? tenant?.id ?? "(la empresa del entorno)";
  return await verificar(env, nombre);
}

async function verificar(env, nombre) {

  // 1. Lo mínimo, antes de gastar una request.
  if (!env.BILLER_API_BASE_URL) fatal("Falta BILLER_API_BASE_URL.");
  if (!env.BILLER_API_TOKEN) fatal("Falta BILLER_API_TOKEN.");

  const ambiente = /^test\./i.test(new URL(env.BILLER_API_BASE_URL).host) ? "test" : "production";
  ok("Ambiente", `${env.BILLER_API_BASE_URL} → ${ambiente}`);

  // 2. El token, contra la API. Es el único chequeo que no puede fallar
  //    silenciosamente: sin token válido no hay nada más que verificar.
  const sonda = await get(env, "/v2/comprobantes/obtener", {
    fecha_desde: `${haceDias(7)} 00:00:00`,
    fecha_hasta: `${haceDias(0)} 23:59:59`,
    ...(env.BILLER_DEFAULT_SUCURSAL_ID ? { sucursal: env.BILLER_DEFAULT_SUCURSAL_ID } : {}),
  });

  if (sonda.status === 401 || sonda.status === 403) {
    falta("Token de Biller", `La API contestó ${sonda.status}: el token no sirve para esta empresa.`);
  } else if (sonda.status >= 500) {
    aviso(
      "Token de Biller",
      `La API contestó ${sonda.status}. Puede ser el rango de fechas (Biller devuelve 500 con ` +
        "rangos grandes en vez de paginar) o un problema del lado de ellos. Reintentá.",
    );
  } else if (sonda.status >= 400) {
    // Un 422 acá suele ser la sucursal: es EL error que no se ve hasta emitir.
    falta(
      "Consulta de comprobantes",
      `La API contestó ${sonda.status}: ${JSON.stringify(sonda.cuerpo).slice(0, 300)}. ` +
        (env.BILLER_DEFAULT_SUCURSAL_ID
          ? `Revisá BILLER_DEFAULT_SUCURSAL_ID="${env.BILLER_DEFAULT_SUCURSAL_ID}": tiene que ser el ` +
            "ID REAL que Biller asigna en Ajustes → Sucursales (ej. 347), no un número genérico como 1."
          : "Probá configurando BILLER_DEFAULT_SUCURSAL_ID."),
    );
  } else {
    const cantidad = Array.isArray(sonda.cuerpo) ? sonda.cuerpo.length : 0;
    ok(
      "Token de Biller",
      `Responde. ${cantidad} comprobantes en los últimos 7 días` +
        (env.BILLER_DEFAULT_SUCURSAL_ID ? ` (sucursal ${env.BILLER_DEFAULT_SUCURSAL_ID})` : ""),
    );
    if (cantidad === 0) {
      aviso(
        "Sin movimiento reciente",
        "No hay comprobantes en los últimos 7 días. No es un error, pero significa que el " +
          "resolvedor de clientes y productos no tiene contra qué resolver todavía: si esta empresa " +
          "factura seguido, revisá que la sucursal sea la correcta.",
      );
    }
  }

  // 3. Sucursal declarada pero sin nombre: los reportes van a decir "sucursal 347".
  if (env.BILLER_DEFAULT_SUCURSAL_ID && !env.BILLER_SUCURSALES_JSON) {
    aviso(
      "Nombres de sucursal",
      "Sin BILLER_SUCURSALES_JSON los reportes dicen \"sucursal " +
        `${env.BILLER_DEFAULT_SUCURSAL_ID}\" en vez del nombre. Ej: {"${env.BILLER_DEFAULT_SUCURSAL_ID}":"Centro"}`,
    );
  }

  // 4. El certificado de DGI: vencido, la empresa no puede emitir. Es el chequeo
  //    que más vale la pena hacer ANTES de prender el número, no después.
  if (env.BILLER_DEFAULT_EMPRESA_RUT) {
    const cert = await get(env, "/v2/dgi/empresas/certificado-unico", {
      rut: env.BILLER_DEFAULT_EMPRESA_RUT,
    });
    if (cert.status >= 400) {
      aviso("Certificado DGI", `No se pudo consultar (${cert.status}).`);
    } else {
      const c = cert.cuerpo ?? {};
      const vence = String(c.Vencimiento ?? "").trim();
      const estado = String(c.Estado ?? "").trim();
      if (vence === "") {
        // Tercer estado real: "NO existe Certificado de Vigencia Anual", con
        // Emision/Vencimiento en whitespace puro.
        falta("Certificado DGI", `Sin certificado vigente. Estado: "${estado || "(vacío)"}".`);
      } else {
        ok("Certificado DGI", `${c.Denominacion ?? ""} — vence ${vence} (estado: ${estado})`);
      }
    }
  } else {
    aviso(
      "RUT de la empresa",
      "Sin BILLER_DEFAULT_EMPRESA_RUT no se puede verificar el certificado de DGI ni etiquetar los " +
        "reportes con el nombre de la empresa.",
    );
  }

  // 5. La clave es obligatoria en las superficies que emiten
  // confirmation_token. No se genera acá: debe ser propia de este tenant y
  // administrarse como secreto por el operador.
  const modoCapacidad = (env.BILLER_CAPABILITY_MODE ?? "").trim().toLowerCase();
  const requiereApproval = modoCapacidad === "write_enabled" || Boolean(env.KAPSO_API_KEY?.trim());
  if (requiereApproval) {
    const longitud = (env.BILLER_APPROVAL_SECRET ?? "").trim().length;
    if (longitud < 32) {
      falta(
        "Clave de approvals",
        "Falta BILLER_APPROVAL_SECRET o tiene menos de 32 caracteres. Generá una exclusiva para " +
          "esta empresa (por ejemplo con `openssl rand -hex 32`); no reutilices otras credenciales.",
      );
    } else {
      ok("Clave de approvals", "Configurada para firmar confirmation_token v2.");
    }
  }

  // 6. El canal de WhatsApp y —lo importante— quién puede usarlo.
  if (env.KAPSO_API_KEY) {
    const remitentes = (env.BILLER_REMITENTES_AUTORIZADOS ?? "").split(",").filter((s) => s.trim());
    const destinatarios = (env.KAPSO_DESTINATARIOS_PERMITIDOS ?? "").split(",").filter((s) => s.trim());
    const efectivos = remitentes.length > 0 ? remitentes : destinatarios;

    if (efectivos.length === 0) {
      falta(
        "Quién puede preguntar",
        "Hay canal de WhatsApp y NINGÚN remitente autorizado: el server va a rechazar todo. " +
          "Configurá BILLER_REMITENTES_AUTORIZADOS. Sin allowlist, cualquiera que conozca el número " +
          "lee la contabilidad de la empresa.",
      );
    } else {
      ok(
        "Quién puede preguntar",
        `${efectivos.length} teléfono(s) autorizado(s)` +
          (remitentes.length > 0 ? "" : " (heredados de KAPSO_DESTINATARIOS_PERMITIDOS)"),
      );
    }

    for (const crudo of [...remitentes, ...destinatarios]) {
      const d = crudo.replace(/\D/g, "");
      if (/^5980/.test(d)) {
        falta(
          "Formato de teléfono",
          `…${d.slice(-4)} lleva el 0 nacional después del 598. En formato internacional ese 0 no ` +
            "va: 095 923 567 se escribe 59895923567. Tal como está, no va a coincidir nunca.",
        );
      } else if (d.length < 8 || d.length > 15) {
        falta("Formato de teléfono", `…${d.slice(-4)} tiene ${d.length} dígitos (válido: 8 a 15).`);
      }
    }

    if (!env.KAPSO_PHONE_NUMBER_ID) {
      falta("Kapso", "Falta KAPSO_PHONE_NUMBER_ID: sin él no se puede enviar nada.");
    } else {
      ok("Kapso", `Configurado (phone_number_id ${env.KAPSO_PHONE_NUMBER_ID}).`);
    }
  } else {
    ok("Canal de WhatsApp", "Sin configurar. El server corre en modo escritorio (stdio).");
  }

  // 7. El valor de la UI se vence. Un umbral viejo hace que un e-Ticket grande
  //    salga sin receptor identificado, que es un problema fiscal, no de UX.
  if (env.BILLER_VALOR_UI) {
    const fecha = env.BILLER_VALOR_UI_FECHA;
    const dias = fecha ? Math.round((Date.now() - Date.parse(fecha)) / 86_400_000) : null;
    if (dias === null) {
      aviso("Valor de la UI", `Configurado (${env.BILLER_VALOR_UI}) pero sin BILLER_VALOR_UI_FECHA.`);
    } else if (dias > 90) {
      falta("Valor de la UI", `El valor es del ${fecha}: hace ${dias} días. Actualizalo.`);
    } else {
      ok("Valor de la UI", `${env.BILLER_VALOR_UI} al ${fecha} (hace ${dias} días).`);
    }
  } else {
    aviso(
      "Valor de la UI",
      "Sin BILLER_VALOR_UI se usa un valor de referencia conservador y los avisos del umbral de " +
        "5.000 UI salen marcados como aproximados.",
    );
  }

  // 8. Escritura en producción: que quede dicho en voz alta.
  if (ambiente === "production" && env.BILLER_WRITE_ENABLED === "true") {
    aviso(
      "Escritura en PRODUCCIÓN",
      "Habilitada. Cada emisión genera un documento fiscal real ante DGI. Se corrige (nota de " +
        "crédito), pero cada corrección es otro comprobante con su propia numeración.",
    );
  }

  // --- Salida ---------------------------------------------------------------

  const faltantes = resultados.filter((r) => r.estado === "falta");

  if (modoJson) {
    console.log(JSON.stringify({ empresa: nombre, ambiente, listo: faltantes.length === 0, resultados }, null, 2));
  } else {
    const icono = { ok: "✓", aviso: "!", falta: "✗" };
    console.log(`\nAlta de empresa: ${nombre}\n`);
    for (const r of resultados) {
      console.log(`  ${icono[r.estado]} ${r.titulo}`);
      console.log(`      ${r.detalle}\n`);
    }
    console.log(
      faltantes.length === 0
        ? "✓ Lista para atender.\n"
        : `✗ Faltan ${faltantes.length} cosa(s) antes de prender el número.\n`,
    );
  }

  process.exit(faltantes.length === 0 ? 0 : 1);
}

main().catch((err) => fatal(err instanceof Error ? err.message : String(err)));
