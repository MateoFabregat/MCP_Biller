// =============================================================================
// Conversar con el asistente desde el backend, sin tocar el teléfono.
//
// POR QUÉ EXISTE. `simular-whatsapp.mjs` prueba las capas por separado —el
// enrutador con el enrutador, las tools con las tools— y eso alcanza para saber
// QUÉ está roto. Lo que no prueba es lo único que le importa al almacenero: que
// el agente de Kapso, con este prompt y estas tools, efectivamente conteste.
// Esa parte vivía únicamente en "escribile al número y fijate", que es lento,
// no deja registro, y cuando falla no dice por qué.
//
// Este script arranca ejecuciones reales del workflow y lee la traza de eventos
// que deja Kapso: qué tools se le configuraron al agente, cuáles llamó, qué
// contestó. Es la misma conversación que tendría el usuario, pero观 observable.
//
// OJO: LOS MENSAJES SON REALES. El agente contesta por WhatsApp al número de la
// conversación. Esto no es un dry-run: es la conversación de verdad, mirada
// desde el otro lado. Por eso el destinatario sale de la allowlist y no de un
// argumento suelto.
//
// USO
//   node --env-file=.env scripts/conversar.mjs "hola"
//   node --env-file=.env scripts/conversar.mjs --guion
// =============================================================================

const API = "https://api.kapso.ai/platform/v1";

function env(clave) {
  return (process.env[clave] ?? "").trim();
}

async function kapso(metodo, ruta, cuerpo) {
  const res = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { "X-API-Key": env("KAPSO_API_KEY"), "content-type": "application/json" },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const crudo = await res.text();
  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch {
    datos = { crudo: crudo.slice(0, 300) };
  }
  return { status: res.status, datos, ok: res.ok };
}

async function workflowActivo() {
  const ws = await kapso("GET", "/workflows");
  const w = (ws.datos?.data ?? []).find((x) => x.status === "active");
  if (w === undefined) throw new Error("No hay ningún workflow en estado active.");
  return w;
}

/**
 * Se asegura de que el flow tenga un trigger `api_call`, que es lo que permite
 * arrancar una ejecución sin que entre un mensaje de WhatsApp.
 *
 * Es idempotente: si ya está, no toca nada. Y es ADITIVO — el trigger de
 * mensajes entrantes sigue igual, así que el número no cambia de comportamiento
 * por tener esto puesto.
 */
async function asegurarTriggerApi(workflowId) {
  const trs = await kapso("GET", `/workflows/${workflowId}/triggers`);
  // "api_call", no "api": el resto del vocabulario de Kapso da 422 "Invalid
  // trigger type". Lo verifiqué probando; la API no lista los tipos válidos.
  const yaHay = (trs.datos?.data ?? []).some((t) => t.trigger_type === "api_call" && t.active === true);
  if (yaHay) return "ya estaba";

  const r = await kapso("POST", `/workflows/${workflowId}/triggers`, {
    trigger: { trigger_type: "api_call", active: true },
  });
  if (!r.ok) throw new Error(`No pude crear el trigger api_call: ${r.status} ${JSON.stringify(r.datos).slice(0, 300)}`);
  return "creado";
}

/**
 * Arranca una ejecución y devuelve su id.
 *
 * `whatsapp_conversation_id` NO es opcional en la práctica. Sin él, la ejecución
 * corre igual pero `get_whatsapp_context` contesta "No WhatsApp conversation
 * associated with this flow execution" y el agente no tiene a dónde escribir:
 * completa la tarea con la respuesta vacía y no sale ningún mensaje. Se ve
 * idéntico a "el agente no contestó", que es justo lo que este script está
 * tratando de distinguir.
 */
async function arrancar(workflowId, telefono, mensaje, conversacionId) {
  const r = await kapso("POST", `/workflows/${workflowId}/executions`, {
    workflow_execution: {
      phone_number: telefono,
      ...(conversacionId === undefined ? {} : { whatsapp_conversation_id: conversacionId }),
      // `variables`, NO `execution_context.vars`. Los dos dan 202 y solo el
      // primero deja la variable puesta; con el segundo la ejecución arranca con
      // vars={} y el `{{last_user_input}}` del system prompt le llega LITERAL al
      // modelo, que entonces manda el menú pase lo que pase. Un 202 no dice que
      // el cuerpo se haya entendido.
      variables: { last_user_input: mensaje },
    },
  });
  if (!r.ok) throw new Error(`POST executions → ${r.status}: ${JSON.stringify(r.datos).slice(0, 400)}`);
  return r.datos?.data?.id;
}

/**
 * Espera a que la ejecución deje de estar corriendo y devuelve su traza.
 *
 * No hay webhook de "terminó", así que se sondea. El corte por tiempo es
 * necesario y no cosmético: una ejecución que se cuelga es justamente uno de
 * los resultados que queremos poder reportar, y sin tope el script se cuelga
 * con ella.
 */
async function esperar(ejecucionId, segundos = 90) {
  const hasta = Date.now() + segundos * 1000;
  let estado = "running";
  while (Date.now() < hasta) {
    await new Promise((r) => setTimeout(r, 3000));
    const e = await kapso("GET", `/workflow_executions/${ejecucionId}`);
    estado = e.datos?.data?.status ?? "?";
    if (estado !== "running" && estado !== "pending") break;
  }
  const evs = await kapso("GET", `/workflow_executions/${ejecucionId}/events`);
  return { estado, eventos: (evs.datos?.data ?? []).slice().reverse() };
}

/** Lo que le importa a un humano de una traza de 20 eventos. */
function resumir(eventos) {
  const tools = [];
  const llamadas = [];
  const dichos = [];
  let handoff = null;

  for (const e of eventos) {
    if (e.event_type === "agent_tools_configured") {
      for (const t of e.payload?.tools ?? []) tools.push(t.name);
    }
    if (e.event_type === "agent_tool_called" && e.payload?.tool_id) {
      llamadas.push(e.payload.tool_name);
    }
    if (e.event_type === "status_changed" && e.payload?.to === "handoff") {
      handoff = e.payload?.metadata?.reason ?? "?";
    }
    // El texto que efectivamente salió para el usuario.
    if (e.event_type === "message_sent" || e.direction === "out") {
      const t = e.payload?.content ?? e.payload?.text ?? e.payload?.message;
      if (typeof t === "string" && t.trim() !== "") dichos.push(t);
    }
  }
  return { tools, llamadas, dichos, handoff };
}

/**
 * LO QUE ESTE SCRIPT NO PUEDE VER, y por qué no lo reporta como falla.
 *
 * La API de plataforma de Kapso no expone los mensajes de una conversación
 * (`/whatsapp/conversations/{id}/messages` da 404, y el objeto de conversación
 * no los trae). Así que lo único que se ve desde acá es lo que dejó la
 * ejecución: qué tools se configuraron, cuáles llamó y qué texto propio produjo.
 *
 * Y ESO ES ENGAÑOSO SI NO SE DICE. El menú NO sale como texto del asistente:
 * sale porque el agente llama `biller_menu_whatsapp` con enviar=true, y esa tool
 * le habla a la API de mensajería de Kapso por su cuenta. O sea que el camino
 * feliz —el que uno quiere ver— deja "texto del agente: vacío". La primera
 * versión de este script lo reportaba como "✗ NO salió ningún mensaje" mientras
 * el menú llegaba perfecto al teléfono.
 *
 * La prueba de que salió está en NUESTRO log, no acá: `kapso.mensaje.enviado`
 * con su `message_id` de WhatsApp (wamid...).
 */
const TOOLS_QUE_ESCRIBEN_SOLAS = new Set([
  "biller_menu_whatsapp",
  "biller_emision_guiada",
  "biller_resolver_nombre",
  "biller_reporte_diario",
  "biller_enviar_comprobante_whatsapp",
  "biller_recordatorio_cobro",
]);

// =============================================================================
// Main
// =============================================================================
const argv = process.argv.slice(2);
const GUION_COMPLETO = argv.includes("--guion");

// El destinatario sale de la allowlist, no de un argumento: mandarle mensajes
// reales a un número que no está autorizado es exactamente lo que la barrera
// existe para impedir, y un script de pruebas no es una excepción.
const telefono = env("BILLER_REMITENTES_AUTORIZADOS").split(",")[0].trim();
if (telefono === "") {
  console.error("Falta BILLER_REMITENTES_AUTORIZADOS: no sé a qué número escribirle.");
  process.exit(1);
}

const w = await workflowActivo();
console.log(`Workflow: ${w.name} (${w.id})`);
console.log(`Trigger api: ${await asegurarTriggerApi(w.id)}`);
console.log(`Destinatario: ${telefono}\n`);

// La conversación de WhatsApp de ese número, si ya existe. Es lo que convierte
// esto en una prueba de punta a punta: el agente contesta AHÍ, por WhatsApp.
const convs = await kapso("GET", "/whatsapp/conversations");
const conversacionId = (convs.datos?.data ?? []).find((c) => c.phone_number === telefono)?.id;
console.log(`Conversación: ${conversacionId ?? "ninguna todavía (escribile una vez desde el teléfono)"}\n`);

const guion = GUION_COMPLETO
  ? ["hola", "quién me debe plata", "cómo viene el mes", "gracias"]
  : [argv.find((a) => !a.startsWith("--")) ?? "hola"];

for (const mensaje of guion) {
  console.log(`\n${"=".repeat(70)}\n> "${mensaje}"`);
  let id;
  try {
    id = await arrancar(w.id, telefono, mensaje, conversacionId);
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const { estado, eventos } = await esperar(id);
  const { tools, llamadas, dichos, handoff } = resumir(eventos);

  console.log(`  estado: ${estado}`);
  console.log(`  tools disponibles: ${tools.length} ${tools.length <= 5 ? `(${tools.join(", ")})` : `(${tools.filter((t) => t.startsWith("biller_")).length} biller_*)`}`);
  console.log(`  tools llamadas: ${llamadas.length > 0 ? llamadas.join(" → ") : "ninguna"}`);
  if (handoff !== null) console.log(`  ✗ HANDOFF (${handoff}): la conversación quedó muda.`);

  const mandoElla = llamadas.some((t) => TOOLS_QUE_ESCRIBEN_SOLAS.has(t));
  if (dichos.length > 0) {
    for (const d of dichos) console.log(`  < ${d.replace(/\n/g, "\n    ").slice(0, 600)}`);
  } else if (mandoElla) {
    console.log(`  < (lo mandó la tool directo por WhatsApp: ${llamadas.filter((t) => TOOLS_QUE_ESCRIBEN_SOLAS.has(t)).join(", ")})`);
    console.log("    Verificalo en el log del server: kapso.mensaje.enviado con su message_id.");
  } else if (tools.filter((t) => t.startsWith("biller_")).length === 0) {
    console.log("  ✗ El agente no tenía NINGUNA tool biller_*: por eso no contestó.");
  } else {
    console.log("  ✗ El agente terminó sin decir nada y sin mandar nada. Eso sí es una falla.");
  }
}
