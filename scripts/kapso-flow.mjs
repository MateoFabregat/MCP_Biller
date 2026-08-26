// =============================================================================
// Crea (o actualiza) el workflow de Kapso que atiende el WhatsApp.
//
// POR QUÉ ES UN SCRIPT Y NO UN CLICK EN EL PANEL
//
// El system prompt del Agent Node es la única parte de este proyecto que vive
// fuera del repo. Copiarlo a mano al panel garantiza que en algún momento el
// que está corriendo y el que está documentado dejen de ser el mismo, y no hay
// forma de notarlo: el flow sigue andando, solo que con instrucciones viejas.
//
// Por eso el prompt se LEE de `docs/FLUJO_WHATSAPP.md` §5, que es su copia
// canónica. Si alguien edita el doc y vuelve a correr esto, el flow queda
// alineado. Si nadie lo corre, al menos el diff del doc dice qué cambió.
//
// USO
//   node scripts/kapso-flow.mjs <url-publica-del-mcp>
//
// La URL es la del endpoint MCP (termina en /mcp). Kapso rechaza cualquier cosa
// que resuelva a localhost: hace falta un túnel o un deploy.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.kapso.ai/platform/v1";
const NOMBRE_WORKFLOW = "Biller — asistente de facturación";

/** Modelo del Agent Node. Sonnet: alcanza de sobra y el flujo es de alto volumen. */
const MODELO = "claude-sonnet-5";

function env(clave, obligatoria = true) {
  const valor = (process.env[clave] ?? "").trim();
  if (valor === "" && obligatoria) {
    console.error(`Falta la variable de entorno ${clave}.`);
    process.exit(1);
  }
  return valor;
}

/** Extrae el bloque ```text de la sección 5 del doc: la copia canónica del prompt. */
function leerSystemPrompt() {
  const doc = readFileSync(join(RAIZ, "docs/FLUJO_WHATSAPP.md"), "utf8");
  const seccion = doc.split("## 5. El system prompt del Agent Node")[1];
  if (seccion === undefined) {
    throw new Error("No se encontró la sección 5 en docs/FLUJO_WHATSAPP.md.");
  }
  const bloque = seccion.match(/```text\n([\s\S]*?)```/);
  if (bloque === null) {
    throw new Error("La sección 5 existe pero no tiene un bloque ```text con el prompt.");
  }
  return bloque[1].trim();
}

async function kapso(metodo, ruta, cuerpo) {
  const res = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      "X-API-Key": env("KAPSO_API_KEY"),
      "content-type": "application/json",
    },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const raw = await res.text();
  let datos;
  try {
    datos = JSON.parse(raw);
  } catch {
    datos = { raw: raw.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(`Kapso ${metodo} ${ruta} → ${res.status}: ${JSON.stringify(datos).slice(0, 600)}`);
  }
  return datos;
}

const urlMcp = process.argv[2];
if (urlMcp === undefined || !/^https:\/\//.test(urlMcp)) {
  console.error("Uso: node scripts/kapso-flow.mjs https://<host-publico>/mcp");
  console.error("Tiene que ser https y NO puede resolver a localhost (Kapso lo rechaza por SSRF).");
  process.exit(1);
}

const systemPrompt = leerSystemPrompt();
const phoneNumberId = env("KAPSO_PHONE_NUMBER_ID");
const httpToken = env("BILLER_HTTP_AUTH_TOKEN");

// --- El modelo ---------------------------------------------------------------
const modelos = await kapso("GET", "/provider_models");
const modelo = modelos.data.find((m) => m.name === MODELO && m.deprecation_status === "active");
if (modelo === undefined) {
  throw new Error(`No se encontró el modelo ${MODELO} activo en este proyecto de Kapso.`);
}

// --- La definición del grafo -------------------------------------------------
//
// Dos nodos y una arista. Toda la lógica de conversación vive en las tools del
// MCP, no en el grafo: un grafo con veinte nodos para "elegir opción" sería la
// misma máquina de estados que `menu.ts` ya tiene testeada, pero sin tests y
// editable desde un panel.
const definition = {
  nodes: [
    {
      id: "start",
      type: "flow-node",
      position: { x: 0, y: 0 },
      data: { node_type: "start", config: {}, display_name: "Entra un mensaje" },
    },
    {
      id: "agente",
      type: "flow-node",
      position: { x: 320, y: 0 },
      data: {
        node_type: "agent",
        display_name: "Asistente de facturación",
        config: {
          system_prompt: systemPrompt,
          provider_model_id: modelo.id,
          temperature: 0,
          max_iterations: 40,
          // Que el texto del agente salga solo. Con `tool_only` habría que
          // mandar cada respuesta con una tool, y cualquier olvido del modelo
          // se ve del otro lado como un visto sin contestar.
          message_delivery_mode: "auto_send_assistant_text",
          enabled_default_tools: ["complete_task", "get_whatsapp_context"],
          flow_agent_mcp_servers: [
            {
              name: "biller",
              url: urlMcp,
              headers: { Authorization: `Bearer ${httpToken}` },
            },
          ],
        },
      },
    },
  ],
  edges: [{ source: "start", target: "agente", label: "next" }],
};

// --- Crear o actualizar ------------------------------------------------------
const existentes = await kapso("GET", "/workflows");
const previo = (existentes.data ?? []).find((w) => w.name === NOMBRE_WORKFLOW);

let workflow;
if (previo === undefined) {
  const r = await kapso("POST", "/workflows", {
    workflow: {
      name: NOMBRE_WORKFLOW,
      description: "Atiende el WhatsApp de la PyME contra el MCP de Biller.",
      definition,
    },
  });
  workflow = r.data;
  console.log(`✓ Workflow creado: ${workflow.id}`);
} else {
  const r = await kapso("PATCH", `/workflows/${previo.id}`, { workflow: { definition } });
  workflow = r.data ?? previo;
  console.log(`✓ Workflow actualizado: ${workflow.id}`);
}

// --- El trigger --------------------------------------------------------------
// Solo un workflow puede tener el trigger activo por número, así que esto es
// idempotente por diseño: si ya existe, se deja como está.
const triggers = await kapso("GET", `/workflows/${workflow.id}/triggers`).catch(() => ({ data: [] }));
const yaHay = (triggers.data ?? []).some(
  (t) => t.trigger_type === "inbound_message" && t.active === true,
);

if (yaHay) {
  console.log("✓ El trigger de mensajes entrantes ya estaba activo.");
} else {
  await kapso("POST", `/workflows/${workflow.id}/triggers`, {
    trigger: { trigger_type: "inbound_message", active: true, phone_number_id: phoneNumberId },
  });
  console.log(`✓ Trigger inbound_message activado para el número ${phoneNumberId}.`);
}

console.log(`\nMCP apuntado a: ${urlMcp}`);
console.log(`System prompt: ${systemPrompt.length} caracteres, leídos de docs/FLUJO_WHATSAPP.md §5.`);
console.log(`Modelo: ${MODELO} (${modelo.id})`);
console.log("\nEscribile \"hola\" al número y debería contestar el menú.");
