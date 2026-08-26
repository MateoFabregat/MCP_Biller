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

/** Arranca una ejecución y devuelve su id. */
async function arrancar(workflowId, telefono, mensaje) {
  const r = await kapso("POST", `/workflows/${workflowId}/executions`, {
    workflow_execution: {
      phone_number: telefono,
      execution_context: { vars: { last_user_input: mensaje } },
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

/** Los mensajes que salieron por WhatsApp en esa conversación. La prueba final. */
async function mensajesDe(conversacionId, desdeIso) {
  const r = await kapso("GET", `/whatsapp/conversations/${conversacionId}/messages`);
  const todos = r.datos?.data ?? [];
  return todos
    .filter((m) => m.direction === "outbound" && (desdeIso === undefined || m.created_at >= desdeIso))
    .map((m) => m.content ?? `[${m.message_type}]`);
}

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

const guion = GUION_COMPLETO
  ? ["hola", "quién me debe plata", "cómo viene el mes", "gracias"]
  : [argv.find((a) => !a.startsWith("--")) ?? "hola"];

for (const mensaje of guion) {
  console.log(`\n${"=".repeat(70)}\n> "${mensaje}"`);
  const desde = new Date().toISOString();
  let id;
  try {
    id = await arrancar(w.id, telefono, mensaje);
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

  const conv = eventos.find((e) => e.payload?.conversation_id)?.payload?.conversation_id;
  const salidos = dichos.length > 0 ? dichos : conv ? await mensajesDe(conv, desde) : [];
  if (salidos.length === 0) {
    console.log("  ✗ NO salió ningún mensaje para el usuario.");
  } else {
    for (const s of salidos) console.log(`  < ${s.replace(/\n/g, "\n    ").slice(0, 600)}`);
  }
}
