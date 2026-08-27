// =============================================================================
// Lo que los tres scripts necesitan de la API de plataforma de Kapso.
//
// POR QUÉ EXISTE. `kapso-flow.mjs`, `simular-whatsapp.mjs` y `conversar.mjs`
// tenían cada uno su propio `env()` y su propio wrapper de fetch con la
// `X-API-Key`, casi idénticos y con diferencias chicas en cómo trataban un
// cuerpo que no es JSON. Tres copias de la misma forma es la manera conocida de
// que dentro de un mes se comporten distinto sin que nadie lo note.
//
// Acá vive además el vocabulario de la API que la documentación NO lista y que
// costó descubrir probando. Cada constante tiene al lado qué pasa si se usa la
// otra, porque el modo de fallar de esta API es contestar 2xx y no hacer nada.
// =============================================================================

const API = "https://api.kapso.ai/platform/v1";

/**
 * El trigger para arrancar una ejecución desde el backend.
 *
 * Es `api_call`. "api", "manual", "webhook", "http", "external" y "test" dan
 * todos 422 "Invalid trigger type", y la API no lista los válidos en ningún
 * lado: se encontró probando.
 */
export const TRIGGER_API = "api_call";

/**
 * Dónde van las variables al crear una ejecución.
 *
 * Es `variables`, en la raíz del `workflow_execution`. Mandarlas en
 * `execution_context.vars` —que es donde después se LEEN— devuelve el mismo
 * 202 y deja la ejecución con `vars: {}`. Consecuencia: el `{{last_user_input}}`
 * del system prompt le llega LITERAL al modelo, que entonces manda el menú diga
 * lo que diga el usuario. Un 202 no dice que el cuerpo se haya entendido.
 */
export const CLAVE_VARIABLES = "variables";

export function env(clave) {
  return (process.env[clave] ?? "").trim();
}

/** El primer remitente de la allowlist: a quién se le puede escribir. */
export function remitentePrincipal() {
  return env("BILLER_REMITENTES_AUTORIZADOS").split(",")[0].trim();
}

/**
 * Una llamada a la API de plataforma.
 *
 * Nunca tira: devuelve `{status, datos, ok}` y deja que el llamador decida. Los
 * 404 de esta API vienen como una página HTML de Django, así que un cuerpo que
 * no es JSON es información —la ruta no existe—, no un error del parser.
 */
export async function kapso(metodo, ruta, cuerpo) {
  const res = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { "X-API-Key": env("KAPSO_API_KEY"), "content-type": "application/json" },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  const crudo = await res.text();
  let datos = null;
  try {
    datos = JSON.parse(crudo);
  } catch {
    datos = null;
  }
  return { status: res.status, datos, ok: res.ok, crudo };
}

/**
 * El workflow activo, o null.
 *
 * Un workflow en `draft` NO CORRE aunque su trigger esté activo, y es
 * indistinguible de uno que anda: por eso se filtra por estado y no se agarra
 * el primero de la lista.
 */
export async function workflowActivo() {
  const ws = await kapso("GET", "/workflows");
  return (ws.datos?.data ?? []).find((w) => w.status === "active") ?? null;
}

/** La URL del MCP que Kapso tiene GUARDADA, que es la única que importa. */
export async function urlMcpConfigurada(workflowId) {
  const def = await kapso("GET", `/workflows/${workflowId}/definition`);
  const agente = (def.datos?.data?.definition?.nodes ?? []).find(
    (n) => n.data?.node_type === "agent",
  );
  return (agente?.data?.config?.flow_agent_mcp_servers ?? [])[0] ?? null;
}
