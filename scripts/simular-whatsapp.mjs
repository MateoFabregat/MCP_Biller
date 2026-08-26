// =============================================================================
// El simulador: le habla al sistema como le habla el almacenero, y dice qué
// contestó de verdad.
//
// POR QUÉ EXISTE. Hasta ahora, "¿anda el WhatsApp?" se respondía escribiéndole
// al número y esperando. Eso mide UNA cosa —el extremo final— y cuando falla no
// dice cuál de las cinco capas se rompió: el workflow de Kapso, el trigger, el
// túnel, el bearer, el enrutador o la tool. Y encima cuesta un mensaje real, con
// una conversación real que puede quedar en un estado del que no se vuelve.
//
// Este script recorre las cinco capas por separado y en orden, y cada una dice
// si pasa o no. La primera que falla explica todo lo de abajo: si Kapso no puede
// conectarse al MCP, no tiene sentido leer los resultados del enrutador.
//
// LAS CINCO FASES
//   1. KAPSO      — ¿el workflow está activo, publicado y con trigger? ¿hay
//                   conversaciones trabadas en handoff? (esto último es lo que
//                   hace que un "hola" no obtenga NADA, sin ningún error.)
//   2. TRANSPORTE — handshake MCP contra la MISMA url que Kapso tiene guardada,
//                   no contra localhost. Es la diferencia entre "mi server anda"
//                   y "Kapso lo alcanza".
//   3. CATÁLOGO   — ¿tools/list trae las tools que el menú promete? Una opción
//                   que apunta a una tool inexistente es una pared.
//   4. ENRUTADOR  — cada botón, cada título y cada sinónimo del menú, pasados
//                   por `interpretarMensaje`. Sin red: es TypeScript puro.
//   5. EJECUCIÓN  — las tools de LECTURA de cada opción, llamadas de verdad
//                   contra Biller a través del MCP.
//
// LO QUE NO HACE, A PROPÓSITO: no emite, no anula, no manda WhatsApps. Las tools
// de escritura y las que le escriben a un tercero se listan y se saltean. Un
// script de diagnóstico que factura es un script que nadie corre dos veces.
//
// USO
//   node --env-file=.env scripts/simular-whatsapp.mjs
//   node --env-file=.env scripts/simular-whatsapp.mjs --url https://otra/mcp
//   node --env-file=.env scripts/simular-whatsapp.mjs --solo enrutador
// =============================================================================

import { ClienteMcp } from "./mcpCliente.mjs";
import { OPCIONES_MENU, interpretarMensaje } from "../dist/kapso/menu.js";

const API_KAPSO = "https://api.kapso.ai/platform/v1";

// --- Argumentos --------------------------------------------------------------
const argv = process.argv.slice(2);
function opcionCli(nombre) {
  const i = argv.indexOf(`--${nombre}`);
  return i === -1 ? undefined : argv[i + 1];
}
const SOLO = opcionCli("solo");
const URL_FORZADA = opcionCli("url");
const corre = (fase) => SOLO === undefined || SOLO === fase;

// --- Presentación ------------------------------------------------------------
const ESC = "";
const NEGRITA = (t) => `${ESC}[1m${t}${ESC}[0m`;
const marcador = {
  ok: `${ESC}[32m✓${ESC}[0m`,
  mal: `${ESC}[31m✗${ESC}[0m`,
  ojo: `${ESC}[33m!${ESC}[0m`,
};

const resultados = [];
function anotar(fase, estado, texto) {
  resultados.push({ fase, estado });
  console.log(`  ${marcador[estado]} ${texto}`);
}
function titulo(n, texto) {
  console.log(`\n${NEGRITA(`${n}. ${texto}`)}`);
}

function env(clave) {
  return (process.env[clave] ?? "").trim();
}

// =============================================================================
// FASE 1 — Kapso
// =============================================================================
async function kapso(ruta) {
  const res = await fetch(`${API_KAPSO}${ruta}`, {
    headers: { "X-API-Key": env("KAPSO_API_KEY") },
  });
  const crudo = await res.text();
  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch {
    datos = null;
  }
  return { status: res.status, datos };
}

/**
 * Mira el estado del canal en Kapso y devuelve la url del MCP que tiene
 * guardada, que es la ÚNICA que importa: la que está en el .env es la que vos
 * creés que configuraste.
 */
async function faseKapso() {
  titulo(1, "KAPSO — el canal");

  if (env("KAPSO_API_KEY") === "") {
    anotar("kapso", "mal", "No hay KAPSO_API_KEY: no puedo mirar el estado del canal.");
    return null;
  }

  const ws = await kapso("/workflows");
  if (ws.status !== 200) {
    anotar("kapso", "mal", `GET /workflows devolvió HTTP ${ws.status}. ¿La API key es de este proyecto?`);
    return null;
  }

  const flows = ws.datos?.data ?? [];
  const activo = flows.find((w) => w.status === "active");
  if (activo === undefined) {
    anotar(
      "kapso",
      "mal",
      `Hay ${flows.length} workflow(s) y NINGUNO está en "active". Un draft no corre aunque el trigger esté prendido.`,
    );
    return null;
  }
  anotar("kapso", "ok", `Workflow "${activo.name}" activo (${activo.execution_count ?? 0} ejecuciones).`);

  const trs = await kapso(`/workflows/${activo.id}/triggers`);
  const inbound = (trs.datos?.data ?? []).find(
    (t) => t.trigger_type === "inbound_message" && t.active === true,
  );
  if (inbound === undefined) {
    anotar("kapso", "mal", "No hay trigger inbound_message activo: los mensajes entrantes no arrancan nada.");
  } else {
    const tel = inbound.triggerable?.phone_number_id ?? "?";
    const esperado = env("KAPSO_PHONE_NUMBER_ID");
    if (esperado !== "" && esperado !== tel) {
      anotar(
        "kapso",
        "mal",
        `El trigger escucha el número ${tel} pero el .env dice ${esperado}. Le estás escribiendo a un número que no dispara este flow.`,
      );
    } else {
      anotar("kapso", "ok", `Trigger inbound_message activo en ${inbound.display_name ?? tel}.`);
    }
  }

  // El handoff: la falla que no deja rastro del lado del usuario.
  //
  // Cuando el agente llama `handoff_to_human`, Kapso pasa la conversación a
  // "handoff" y DEJA DE CONTESTAR — está esperando a una persona que no existe.
  // Del lado del WhatsApp no hay error, no hay aviso, no hay nada: los mensajes
  // se entregan y no vuelve ninguno. Es exactamente el síntoma "le escribo hola
  // y ni me contesta", y NO se arregla arreglando el MCP: la conversación
  // trabada sigue trabada aunque las tools vuelvan.
  const ex = await kapso(`/workflows/${activo.id}/executions`);
  const trabadas = (ex.datos?.data ?? []).filter((e) => e.status === "handoff");
  if (trabadas.length > 0) {
    anotar(
      "kapso",
      "mal",
      `${trabadas.length} conversación(es) EN HANDOFF: Kapso dejó de contestarlas y no avisa. Mientras sigan así, ese chat no responde ni a "hola".`,
    );
    for (const t of trabadas) {
      const evs = await kapso(`/workflow_executions/${t.id}/events`);
      const cambio = (evs.datos?.data ?? []).find(
        (e) => e.event_type === "status_changed" && e.payload?.to === "handoff",
      );
      console.log(
        `      · ${t.id.slice(0, 8)} desde ${t.last_event_at} — razón: ${cambio?.payload?.metadata?.reason ?? "?"}`,
      );
    }
  } else {
    anotar("kapso", "ok", "Ninguna conversación trabada en handoff.");
  }

  const def = await kapso(`/workflows/${activo.id}/definition`);
  const agente = (def.datos?.data?.definition?.nodes ?? []).find((n) => n.data?.node_type === "agent");
  const mcp = (agente?.data?.config?.flow_agent_mcp_servers ?? [])[0];
  if (mcp === undefined) {
    anotar("kapso", "mal", "El Agent Node NO tiene ningún MCP server configurado: el agente no tiene con qué contestar.");
    return { workflowId: activo.id, url: null };
  }
  anotar("kapso", "ok", `MCP "${mcp.name}" apuntado a ${mcp.url}`);
  if (/ngrok|loca\.lt|trycloudflare/.test(mcp.url)) {
    anotar(
      "kapso",
      "ojo",
      "Es un TÚNEL de desarrollo. Si la máquina se apaga o el túnel se cae, el número queda mudo sin ningún error visible.",
    );
  }
  return { workflowId: activo.id, url: mcp.url };
}

// =============================================================================
// FASE 2 y 3 — transporte y catálogo
// =============================================================================
async function faseTransporte(url) {
  titulo(2, "TRANSPORTE — el MCP, desde afuera");

  const token = env("BILLER_HTTP_AUTH_TOKEN");
  if (token === "") {
    anotar("transporte", "mal", "No hay BILLER_HTTP_AUTH_TOKEN local: no puedo autenticarme como se autentica Kapso.");
    return null;
  }

  const cliente = new ClienteMcp(url, token);
  try {
    const info = await cliente.conectar();
    anotar("transporte", "ok", `Handshake OK con ${info.serverInfo?.name} ${info.serverInfo?.version}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    anotar("transporte", "mal", `No pude conectarme: ${msg}`);
    if (/401/.test(msg)) {
      console.log("      Ojo con lo que ESTO no prueba: lo probé con el token de tu .env.");
      console.log("      Kapso guarda su propia copia del header y la API no la devuelve. Si el token rotó,");
      console.log("      Kapso sigue mandando el viejo: se conecta, come 401, y el agente queda con CERO tools.");
    }
    return null;
  }
  return cliente;
}

async function faseCatalogo(cliente) {
  titulo(3, "CATÁLOGO — ¿están las tools que el menú promete?");

  let tools;
  try {
    tools = await cliente.listarTools();
  } catch (err) {
    anotar("catalogo", "mal", `tools/list falló: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const nombres = new Set(tools.map((t) => t.name));
  anotar("catalogo", "ok", `tools/list devolvió ${tools.length} tools.`);

  // Cero tools merece nombrarse fuerte: no es un error de red ni un 500, el
  // agente arranca igual y con lo único que le queda —`handoff_to_human`— traba
  // la conversación. Es la cadena entera de esta falla en un renglón.
  if (tools.length === 0) {
    anotar(
      "catalogo",
      "mal",
      "CERO tools. El agente arranca sin nada, llama handoff_to_human con reason=missing_tools y la conversación queda muda para siempre.",
    );
    return null;
  }

  const faltantes = [];
  for (const o of OPCIONES_MENU) {
    for (const t of o.tools) if (!nombres.has(t)) faltantes.push(`${o.id} → ${t}`);
  }
  if (faltantes.length === 0) {
    anotar("catalogo", "ok", `Las ${OPCIONES_MENU.length} opciones del menú apuntan a tools que existen.`);
  } else {
    anotar("catalogo", "mal", `Opciones que apuntan a tools inexistentes: ${faltantes.join(", ")}`);
  }
  return nombres;
}

// =============================================================================
// FASE 4 — el enrutador
// =============================================================================
/**
 * Le pasa al enrutador lo que realmente llega desde WhatsApp.
 *
 * TRES FORMAS POR CADA OPCIÓN, porque son tres caminos distintos del código:
 * el id (lo que manda el botón tocado), el título (lo que la gente copia y
 * pega de la lista) y los sinónimos (lo que escribe de memoria). Que ande uno
 * no dice nada de los otros dos.
 */
function faseEnrutador() {
  titulo(4, "ENRUTADOR — cada botón y cada frase");

  // El vocabulario es `read_only` | `write_enabled`, y el default es el seguro.
  // Escrito al revés —cualquier cosa distinta de "read_only" cuenta como
  // escritura— este simulador leía `write_enabled` como un modo desconocido, el
  // enrutador excluía las opciones de escritura de las candidatas, y el reporte
  // acusaba al enrutador de tres fallos que eran de acá. Un diagnosticador que
  // inventa fallas es peor que ninguno: manda a arreglar código que anda.
  const modo = env("BILLER_CAPABILITY_MODE").toLowerCase() === "write_enabled" ? "write_enabled" : "read_only";
  console.log(`  ${marcador.ok} Modo de capacidades: ${modo}`);
  resultados.push({ fase: "enrutador", estado: "ok" });
  let bien = 0;
  let mal = 0;
  const fallos = [];

  for (const o of OPCIONES_MENU) {
    const entradas = [
      { que: "botón", texto: o.id },
      { que: "título", texto: o.titulo },
      ...o.sinonimos.slice(0, 3).map((s) => ({ que: "frase", texto: s })),
    ];
    for (const e of entradas) {
      const r = interpretarMensaje(e.texto, { capabilityMode: modo });
      // `no_disponible` es un ACIERTO cuando la opción pide escritura y el modo
      // es read_only: el enrutador la reconoció y explicó por qué no se puede.
      const acerto =
        r.opcion?.id === o.id ||
        (r.via === "no_disponible" && o.requiereEscritura === true && modo === "read_only");
      if (acerto) bien++;
      else {
        mal++;
        fallos.push(`${o.id}: ${e.que} "${e.texto}" → via=${r.via} opcion=${r.opcion?.id ?? "null"}`);
      }
    }
  }

  if (mal === 0) anotar("enrutador", "ok", `${bien}/${bien} entradas enrutadas a la opción correcta.`);
  else {
    anotar("enrutador", "mal", `${mal} de ${bien + mal} entradas NO llegaron a su opción:`);
    for (const f of fallos.slice(0, 20)) console.log(`      · ${f}`);
  }

  // Los casos que no son opciones del menú y que igual tienen que tener una
  // respuesta. "hola" es el que motivó todo esto.
  const especiales = [
    { texto: "hola", espera: "saludo" },
    { texto: "buenas", espera: "saludo" },
    { texto: "menú", espera: "saludo" },
    { texto: "gracias", espera: "cortesia" },
    { texto: "asdkjhasd", espera: "desconocido" },
  ];
  for (const c of especiales) {
    const r = interpretarMensaje(c.texto, { capabilityMode: modo });
    if (r.via === c.espera) {
      anotar("enrutador", "ok", `"${c.texto}" → via=${r.via}${r.mostrar_menu ? " + menú" : ""}`);
    } else {
      anotar("enrutador", "mal", `"${c.texto}" → via=${r.via}, esperaba ${c.espera}`);
    }
  }
}

// =============================================================================
// FASE 5 — ejecución real
// =============================================================================
/**
 * Argumentos mínimos para llamar cada tool de lectura de verdad.
 *
 * `remitente` va en todas porque la barrera de entrada lo exige: sin él, todo
 * contesta "no autorizado" y el simulador reportaría un canal roto que en
 * realidad está bien cerrado.
 */
function argumentos(nombre, remitente) {
  const hoy = new Date().toISOString().slice(0, 10);
  const porTool = {
    biller_menu_whatsapp: { mensaje: "hola", enviar: false },
    biller_emision_guiada: { mensaje: "hola", enviar: false },
    biller_requisitos_comprobante: { tipo_comprobante: 101 },
    biller_listar_comprobantes_recibidos: { fecha_desde: hoy.slice(0, 8) + "01", fecha_hasta: hoy },
    biller_buscar_cliente_por_rut: { rut: "217994420011" },
    biller_resolver_nombre: { texto: "a", tipo: "cliente", enviar: false },
    biller_reporte_diario: { enviar: false },
    biller_resumen_facturacion_periodo: { periodo: hoy.slice(0, 7) },
    biller_plan_anulacion: { tipo_comprobante: 101, serie: "A", numero: 1 },
  };
  return { remitente, ...(porTool[nombre] ?? {}) };
}

/** Tools que NO se llaman ni en broma: emiten, anulan, o le escriben a un tercero. */
const INTOCABLES = new Set([
  "biller_emitir_comprobante",
  "biller_anular_comprobante",
  "biller_crear_cliente",
  "biller_cargar_producto",
  "biller_crear_recibo",
  "biller_cancelar_recibo",
  "biller_crear_pago",
  "biller_enviar_comprobante_whatsapp",
  "biller_recordatorio_cobro",
]);

async function faseEjecucion(cliente, nombres) {
  titulo(5, "EJECUCIÓN — las tools de lectura, contra Biller de verdad");

  const remitente = (env("BILLER_REMITENTES_AUTORIZADOS").split(",")[0] ?? "").trim();
  if (remitente === "") {
    anotar("ejecucion", "mal", "No hay BILLER_REMITENTES_AUTORIZADOS: la barrera de entrada va a rechazar todo.");
    return;
  }

  const yaVistas = new Set();
  for (const o of OPCIONES_MENU) {
    const leibles = o.tools.filter((t) => !INTOCABLES.has(t) && nombres.has(t) && !yaVistas.has(t));
    if (leibles.length === 0) {
      const saltadas = o.tools.filter((t) => INTOCABLES.has(t));
      if (saltadas.length > 0) {
        console.log(`  ${marcador.ojo} ${o.id.padEnd(22)} salteada (escribe: ${saltadas.join(", ")})`);
      }
      continue;
    }
    for (const t of leibles) {
      yaVistas.add(t);
      const r = await cliente.llamar(t, argumentos(t, remitente));
      const muestra = (r.texto ?? "").replace(/\s+/g, " ").slice(0, 88);
      if (r.ok) {
        anotar("ejecucion", "ok", `${o.id.padEnd(22)} ${t.padEnd(38)} ${muestra}`);
      } else if (r.capa === "tool") {
        // La tool contestó un error de negocio. Viajó y se ejecutó: el canal
        // anda. Va en amarillo, no en rojo.
        anotar("ejecucion", "ojo", `${o.id.padEnd(22)} ${t.padEnd(38)} ${muestra}`);
      } else {
        anotar("ejecucion", "mal", `${o.id.padEnd(22)} ${t.padEnd(38)} [${r.capa}] ${r.detalle}`);
      }
    }
  }
}

// =============================================================================
// Main
// =============================================================================
console.log(NEGRITA("Simulador del canal de WhatsApp") + " — recorre las cinco capas y dice cuál falla.");

let url = URL_FORZADA;
if (corre("kapso")) {
  const r = await faseKapso();
  if (url === undefined) url = r?.url ?? undefined;
}

if (corre("enrutador")) faseEnrutador();

if (SOLO === "enrutador") {
  // Nada más que hacer: el enrutador no necesita red.
} else if (url === undefined || url === null) {
  titulo(2, "TRANSPORTE");
  anotar("transporte", "mal", "No sé a qué URL apunta Kapso y no me pasaron --url. No puedo probar el MCP como lo ve Kapso.");
} else {
  const cliente = await faseTransporte(url);
  if (cliente !== null) {
    const nombres = await faseCatalogo(cliente);
    if (nombres !== null && corre("ejecucion")) await faseEjecucion(cliente, nombres);
  }
}

// --- Veredicto ---------------------------------------------------------------
const malos = resultados.filter((r) => r.estado === "mal").length;
const ojos = resultados.filter((r) => r.estado === "ojo").length;
const bienes = resultados.filter((r) => r.estado === "ok").length;
console.log(`\n${NEGRITA("Veredicto:")} ${bienes} bien, ${ojos} con reparo, ${malos} mal.`);
process.exit(malos > 0 ? 1 : 0);
