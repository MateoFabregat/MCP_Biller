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
import { hoyIsoUy } from "../dist/services/fechaUy.js";
import { WRITE_TOOL_NAMES } from "../dist/tools/register.js";
import { env, kapso, remitentePrincipal, urlMcpConfigurada, workflowActivo } from "./kapsoCliente.mjs";

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

// =============================================================================
// FASE 1 — Kapso
// =============================================================================
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

  const ws = await kapso("GET", "/workflows");
  if (ws.status !== 200) {
    anotar("kapso", "mal", `GET /workflows devolvió HTTP ${ws.status}. ¿La API key es de este proyecto?`);
    return null;
  }

  const flows = ws.datos?.data ?? [];
  const activo = await workflowActivo();
  if (activo === null) {
    anotar(
      "kapso",
      "mal",
      `Hay ${flows.length} workflow(s) y NINGUNO está en "active". Un draft no corre aunque el trigger esté prendido.`,
    );
    return null;
  }
  anotar("kapso", "ok", `Workflow "${activo.name}" activo (${activo.execution_count ?? 0} ejecuciones).`);

  const trs = await kapso("GET", `/workflows/${activo.id}/triggers`);
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
  const ex = await kapso("GET", `/workflows/${activo.id}/executions`);
  const trabadas = (ex.datos?.data ?? []).filter((e) => e.status === "handoff");
  if (trabadas.length > 0) {
    anotar(
      "kapso",
      "mal",
      `${trabadas.length} conversación(es) EN HANDOFF: Kapso dejó de contestarlas y no avisa. Mientras sigan así, ese chat no responde ni a "hola".`,
    );
    for (const t of trabadas) {
      const evs = await kapso("GET", `/workflow_executions/${t.id}/events`);
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

  // Ejecuciones que MURIERON, que se ven igual que el handoff desde el chat.
  //
  // Kapso marca el mensaje como leído y muestra "escribiendo…" ANTES de correr
  // el agente. Si el paso falla —se acabaron los créditos del proyecto, el
  // modelo no responde, lo que sea— el usuario ve los tres puntitos, después
  // nada, y no hay ningún error de este lado: el MCP está impecable, las tools
  // cargan, el enrutador anda. Todo verde y el número mudo.
  //
  // El error vive en el evento de la ejecución y en ningún otro lugar, así que
  // se lee de ahí y se muestra tal cual.
  const fallidas = (ex.datos?.data ?? []).filter((e) => e.status === "failed");
  if (fallidas.length > 0) {
    anotar(
      "kapso",
      "mal",
      `${fallidas.length} ejecución(es) FALLADAS. El usuario ve "escribiendo…" y después nada.`,
    );
    const motivos = new Set();
    for (const f of fallidas.slice(0, 5)) {
      const evs = await kapso("GET", `/workflow_executions/${f.id}/events`);
      const fin = (evs.datos?.data ?? []).find((e) => e.event_type === "execution_failed");
      const error = fin?.payload?.error ?? "(sin detalle)";
      if (!motivos.has(error)) {
        motivos.add(error);
        console.log(`      · ${f.started_at}: ${String(error).slice(0, 200)}`);
      }
    }
  } else {
    anotar("kapso", "ok", "Ninguna ejecución falló.");
  }

  const mcp = await urlMcpConfigurada(activo.id);
  if (mcp === null) {
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
  const flojos = [];

  for (const o of OPCIONES_MENU) {
    const entradas = [
      { que: "botón", texto: o.id },
      { que: "título", texto: o.titulo },
      // TODOS los sinónimos, no los tres primeros. Es TypeScript puro y sin
      // red: probar una muestra no ahorra nada medible y deja la mayoría del
      // vocabulario sin verificar. Las dos colisiones que encontró la primera
      // corrida de este script estaban justamente en el vocabulario, no en la
      // maquinaria.
      ...o.sinonimos.map((s) => ({ que: "frase", texto: s })),
    ];
    for (const e of entradas) {
      const r = interpretarMensaje(e.texto, { capabilityMode: modo });
      // `no_disponible` es un ACIERTO cuando la opción pide escritura y el modo
      // es read_only: el enrutador la reconoció y explicó por qué no se puede.
      const acerto =
        r.opcion?.id === o.id ||
        (r.via === "no_disponible" && o.requiereEscritura === true && modo === "read_only");
      // Llegar por `aproximado` es llegar por parecido, no por certeza: el
      // enrutador mismo marca esa vía como "se le pareció". Cuenta como acierto
      // —el usuario termina donde quería— pero se lista aparte, porque un
      // sinónimo que solo se alcanza por typo es un sinónimo que conviene
      // escribir bien en el catálogo.
      if (acerto) {
        bien++;
        if (r.via === "aproximado") flojos.push(`${o.id}: "${e.texto}" llega solo por parecido`);
      } else {
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

  if (flojos.length > 0) {
    anotar("enrutador", "ojo", `${flojos.length} entradas llegan solo por parecido:`);
    for (const f of flojos.slice(0, 8)) console.log(`      · ${f}`);
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
function argumentos(nombre, remitente, idComprobante) {
  // `hoyIsoUy`, no `toISOString()`: el HANDBOOK §4.6 dice que es la única
  // respuesta válida a "¿qué día es?", y acá no es cosmético. Corriendo esto a
  // las 21:30 de Montevideo, UTC ya está en mañana: el simulador pediría un día
  // que todavía no pasó y —el 1º a la mañana— un período de otro mes. Reportar
  // cero ventas por la zona horaria es exactamente la falla inventada contra la
  // que este script existe para no cometer.
  const hoy = hoyIsoUy();
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
    // Estas dos NO se pueden probar con un id inventado: necesitan uno que
    // exista. Se las llama solo si `idComprobante` vino de la lista real.
    biller_obtener_comprobante: { id: idComprobante },
    biller_obtener_pdf: { id: idComprobante, incluir_base64: false },
  };
  return { remitente, ...(porTool[nombre] ?? {}) };
}

/** Tools que no se pueden probar sin un comprobante que exista de verdad. */
const NECESITAN_COMPROBANTE = new Set(["biller_obtener_comprobante", "biller_obtener_pdf"]);

/**
 * Busca un comprobante real para poder probar las que piden un id.
 *
 * Sin esto, `biller_obtener_comprobante` y `biller_obtener_pdf` se llamaban con
 * un id inventado y el simulador reportaba dos fallas que eran suyas. Y si la
 * empresa no tiene comprobantes en la ventana, la respuesta honesta no es un
 * error: es "no hay con qué probar esto".
 */
async function buscarUnComprobante(cliente, remitente) {
  const r = await cliente.llamar("biller_listar_comprobantes_emitidos", { remitente, limit: 1 });
  if (!r.ok) return null;
  try {
    const lista = JSON.parse(r.texto ?? "{}").comprobantes ?? [];
    return lista[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * ¿El error lo causó el simulador al armar los argumentos, o la tool al correr?
 *
 * Un `-32602 Input validation error` significa que los argumentos ni siquiera
 * pasaron el schema: es un bug de `argumentos()`, no de la tool. Marcarlo igual
 * que "no hay comprobantes en ese período" hacía que el veredicto cerrara en
 * verde con el diagnosticador roto — que es la peor falla posible para esto.
 */
function esCulpaDelSimulador(texto) {
  const t = texto ?? "";
  return t.includes("Input validation error") || t.includes('"kind":"validation"');
}

/**
 * Tools que NO se llaman ni en broma: emiten, anulan, o le escriben a un tercero.
 *
 * LAS DE ESCRITURA SALEN DE `WRITE_TOOL_NAMES`, no de una lista escrita acá.
 * Copiadas a mano, el día que se registre una tool de escritura nueva nadie se
 * va a acordar de agregarla —es un archivo que se toca por otra razón— y este
 * script la va a LLAMAR. O sea: un script de diagnóstico emitiendo un CFE real
 * porque una lista quedó vieja. Es el mismo accidente que esta misma rama
 * arregla en `ORIGENES_IMPUTACION`, pero con consecuencia fiscal.
 *
 * Las dos que se suman son de lectura y no tocan plata, pero le mandan un
 * WhatsApp a un tercero —al cliente que le debe— y eso no se hace para probar.
 */
const INTOCABLES = new Set([
  ...WRITE_TOOL_NAMES,
  "biller_enviar_comprobante_whatsapp",
  "biller_recordatorio_cobro",
]);

async function faseEjecucion(cliente, nombres) {
  titulo(5, "EJECUCIÓN — las tools de lectura, contra Biller de verdad");

  const remitente = remitentePrincipal();
  if (remitente === "") {
    anotar("ejecucion", "mal", "No hay BILLER_REMITENTES_AUTORIZADOS: la barrera de entrada va a rechazar todo.");
    return;
  }

  // De quién es cada tool, para poder decir "esto es la opción 4 del menú".
  const duenio = new Map();
  for (const o of OPCIONES_MENU) {
    for (const t of o.tools) if (!duenio.has(t)) duenio.set(t, o.id);
  }

  /**
   * SE RECORREN TODAS LAS TOOLS DE LECTURA, no solo las que alcanza el menú.
   *
   * Recorrer `OPCIONES_MENU` parecía lo correcto —la spec pedía "cada botón"—
   * y dejaba afuera justo la más importante: `biller_menu_whatsapp` no figura
   * en los `tools` de ninguna opción, porque es la que INTERPRETA el mensaje,
   * no la que contesta una. O sea que la tool que responde "hola" —el síntoma
   * que originó todo esto— era la única que el simulador nunca ejecutaba.
   * Igual `biller_health_check` y `biller_posicion_iva`.
   *
   * El catálogo del wire es la lista honesta de lo que hay que probar. El menú
   * solo sirve para etiquetar.
   */
  const aProbar = [...nombres].filter((t) => !INTOCABLES.has(t)).sort((a, b) => {
    const da = duenio.get(a) ?? "zzz";
    const db = duenio.get(b) ?? "zzz";
    return da === db ? a.localeCompare(b) : da.localeCompare(db);
  });

  const idComprobante = await buscarUnComprobante(cliente, remitente);

  for (const t of aProbar) {
    const etiqueta = (duenio.get(t) ?? "(fuera del menú)").padEnd(22);
    if (NECESITAN_COMPROBANTE.has(t) && idComprobante === null) {
      anotar("ejecucion", "ojo", `${etiqueta} ${t.padEnd(38)} sin probar: la empresa no tiene ningún comprobante emitido.`);
      continue;
    }
    const r = await cliente.llamar(t, argumentos(t, remitente, idComprobante));
    const muestra = (r.texto ?? "").replace(/\s+/g, " ").slice(0, 84);
    if (r.ok) {
      anotar("ejecucion", "ok", `${etiqueta} ${t.padEnd(38)} ${muestra}`);
    } else if (r.capa === "tool" && esCulpaDelSimulador(r.texto)) {
      // NO es lo mismo "la tool contestó que no hay datos" que "la llamé mal".
      // Lo segundo es un bug DE ACÁ, y en amarillo se lee como si la tool
      // anduviera: el veredicto salía 0 con el simulador roto.
      anotar("ejecucion", "mal", `${etiqueta} ${t.padEnd(38)} el simulador la llamó mal: ${muestra}`);
    } else if (r.capa === "tool") {
      // Error de negocio: viajó, se ejecutó y contestó. El canal anda.
      anotar("ejecucion", "ojo", `${etiqueta} ${t.padEnd(38)} ${muestra}`);
    } else {
      anotar("ejecucion", "mal", `${etiqueta} ${t.padEnd(38)} [${r.capa}] ${r.detalle}`);
    }
  }

  const salteadas = [...nombres].filter((t) => INTOCABLES.has(t));
  console.log(`  ${marcador.ojo} ${salteadas.length} tools sin probar porque escriben o le mandan a un tercero:`);
  console.log(`      ${salteadas.join(", ")}`);
}

// =============================================================================
// Main
// =============================================================================
console.log(NEGRITA("Simulador del canal de WhatsApp") + " — recorre las cinco capas y dice cuál falla.");

// La URL se resuelve SIEMPRE, corra o no la fase 1.
//
// Antes se leía solo dentro de `faseKapso`, así que `--solo ejecucion` se
// quedaba sin URL y reportaba "TRANSPORTE: mal — no sé a qué URL apunta Kapso"
// con el canal perfectamente sano. Un diagnosticador que inventa una falla
// cuando lo corrés en modo parcial enseña a desconfiar de todo lo que dice.
let url = URL_FORZADA;
if (corre("kapso")) {
  const r = await faseKapso();
  if (url === undefined) url = r?.url ?? undefined;
} else if (url === undefined && env("KAPSO_API_KEY") !== "") {
  const w = await workflowActivo();
  if (w !== null) url = (await urlMcpConfigurada(w.id))?.url;
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
