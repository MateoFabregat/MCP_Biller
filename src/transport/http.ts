// =============================================================================
// Transporte HTTP (Streamable HTTP) del server MCP.
//
// PARA QUÉ EXISTE: los Agent Nodes de Kapso aceptan MCP servers externos
// (`flow_agent_mcp_servers`), pero por protección contra SSRF rechazan URLs que
// resuelven a localhost. Con stdio no hay forma de conectarlos. Este transporte
// es lo único que faltaba para que el dueño de una PyME pregunte "¿cuánto
// facturé este mes?" por WhatsApp y conteste el mismo código que ya contesta en
// Claude Desktop.
//
// POSTURA DE SEGURIDAD (el stdio no la necesitaba; esto sí):
//   - Bind a 127.0.0.1 por DEFECTO. Exponerlo a 0.0.0.0 es una decisión
//     explícita del operador, no algo que pase por descuido.
//   - Token propio obligatorio, distinto del de Biller (ver httpAuth.ts). Sin
//     token configurado, el server NO ARRANCA en modo http.
//   - Protección contra DNS rebinding activada.
//   - Sesión por conexión: cada cliente MCP tiene su propio transporte.
//   - El modo de capacidades sigue mandando: si el server está en `read_only`,
//     por HTTP tampoco hay tools de escritura.
//
// Nota sobre el despliegue: 127.0.0.1 + un túnel (o un reverse proxy con TLS)
// es la forma correcta de darle una URL pública a Kapso. Poner el proceso
// directamente en 0.0.0.0 sin TLS manda el bearer en texto plano.
// =============================================================================

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
  type BillerConfig,
} from "../config.js";
import type { BorradorStore } from "../kapso/borradorStore.js";
import {
  HEADER_FIRMA,
  MAX_BODY_BYTES,
  decidirWebhook,
  firmaValida,
  normalizarEvento,
} from "../kapso/webhook.js";
import { logger } from "../logger.js";
import { enmascararTelefono, remitentesAutorizados } from "../security/remitentes.js";
import { autenticarConTenants } from "../tenants/acceso.js";
import type { FuenteRegistroTenants } from "../tenants/holder.js";
import { resolverTenantPorId } from "../tenants/registry.js";
import type { RegistroTenants, Tenant } from "../tenants/registry.js";
import { conDialectoLimpio } from "./dialecto.js";

/** Ruta del endpoint MCP. Kapso apunta acá. */
export const MCP_PATH = "/mcp";
/** Ruta de liveness, SIN autenticación y sin datos. Para el orquestador. */
export const HEALTH_PATH = "/healthz";
/**
 * Ruta del webhook de Kapso (C8) EN MODO DE UNA SOLA EMPRESA. Solo existe si hay
 * `KAPSO_WEBHOOK_SECRET`.
 *
 * No usa el bearer del transporte: quien la llama es Kapso, no un cliente MCP, y
 * su credencial es la firma HMAC del cuerpo. Ver `kapso/webhook.ts`.
 *
 * CON EMPRESAS CONFIGURADAS ESTA RUTA MUERE (404 + log de error). No es
 * compatibilidad que se conserva por las dudas: la única forma de atenderla
 * sería con la config del proceso, que es el bug entero —allowlist, capability
 * mode y BorradorStore de una empresa aplicados a los mensajes de otra—. El caso
 * real que cubre es el que importa: alguien migra a multi-empresa y se olvida de
 * cambiar la URL en el panel de Kapso. Con 404 ese número queda mudo y el log en
 * error dice exactamente qué pasó; atendiéndolo, ese número contesta bien y
 * factura mal. Es la misma elección que hace el overlay: pisar, no completar.
 */
export const WEBHOOK_PATH = "/kapso/webhook";

/**
 * La ruta del webhook DE UNA EMPRESA: `/kapso/webhook/<tenant-id>`.
 *
 * EL HUEVO Y LA GALLINA QUE RESUELVE. Con varias empresas, un solo
 * `KAPSO_WEBHOOK_SECRET` compartido significa que cualquiera que lo tenga puede
 * firmar eventos de otra empresa: la firma dejaría de decir "esto viene de
 * Kapso PARA ESTA empresa" y pasaría a decir apenas "esto viene de alguien del
 * despliegue". Pero un secreto por empresa no se puede elegir leyendo el cuerpo,
 * porque para confiar en el cuerpo hay que haber verificado la firma, y para
 * verificarla hay que haber elegido el secreto.
 *
 * La salida no es ordenar las operaciones: es que el mismatch no exista. EL PATH
 * SELECCIONA EL SECRETO, y el path lo configura el operador en Kapso, no quien
 * escribe. Un cuerpo firmado con el secreto de A contra la ruta de B falla la
 * firma y da 401 — no porque alguien haya comparado dos tenants, sino porque el
 * único secreto que esa ruta conoce es el de B.
 *
 * El id de empresa en la URL no es un secreto y no hace falta que lo sea: sin la
 * firma hecha con SU secreto, conocer la ruta no habilita nada.
 */
export function rutaWebhookTenant(tenantId: string): string {
  return `${WEBHOOK_PATH}/${tenantId}`;
}

/**
 * Lo que el webhook necesita de UNA empresa para atender un evento suyo.
 *
 * Son las dos cosas que antes se tomaban del proceso, y las dos estaban mal en
 * cuanto hay más de una empresa: la `config` trae la allowlist de remitentes, el
 * capability mode y el secreto del webhook; el `borradores` es el store SALADO
 * CON EL `cacheId` DE ESA EMPRESA. Ese último es el detalle que muerde: el del
 * proceso no resuelve las claves de sesión de ningún tenant, así que
 * `en_flujo` da falso siempre y una corrección en medio de una carga se
 * autorresponde con el menú entero.
 */
export interface AmbitoWebhook {
  /** Id de la empresa, para el log. `null` en modo de una sola empresa. */
  tenantId: string | null;
  config: BillerConfig;
  borradores?: BorradorStore;
}

/**
 * Cómo conseguir el ámbito de una empresa. Lo inyecta `index.ts`, que es quien
 * tiene el cache de contextos por tenant (`ContextosPorTenant`): este módulo no
 * construye contextos ni sabe cómo se arma una config.
 *
 * Devuelve `null` si el ámbito no se puede armar (config incompleta): ahí la
 * ruta de esa empresa se comporta como si no existiera, igual que sin secreto.
 */
export type ResolverAmbitoWebhook = (tenant: Tenant) => AmbitoWebhook | null;

type RegistroTenantsVigente = RegistroTenants | FuenteRegistroTenants;

function snapshotRegistro(fuente: RegistroTenantsVigente): RegistroTenants {
  return "actual" in fuente ? fuente.actual() : fuente;
}

export interface HttpTransportHandle {
  /** Puerto realmente escuchado (útil cuando se pide 0 en los tests). */
  port: number;
  /** Revoca las sesiones ya abiertas de tenants removidos o modificados. */
  cerrarSesionesTenants(tenantIds: readonly string[]): number;
  close: () => Promise<void>;
}

function responderJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // El contenido es contabilidad: que ningún intermediario lo cachee.
    "cache-control": "no-store",
  });
  res.end(payload);
}

/**
 * Error JSON-RPC, que es lo que un cliente MCP sabe interpretar. Devolver un
 * error HTTP "pelado" hace que el cliente reporte "conexión rota" en vez del
 * motivo real.
 */
function responderErrorRpc(res: ServerResponse, status: number, message: string): void {
  responderJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 || status === 403 ? -32001 : -32000, message },
    id: null,
  });
}

/** Registro vacío: modo de un solo tenant, que es el default. */
const SIN_TENANTS: RegistroTenants = { tenants: [], porToken: new Map(), porPhoneNumberId: new Map() };

/**
 * Lee el cuerpo CRUDO con tope. La firma se calcula sobre estos bytes exactos.
 *
 * SE ACUMULAN BUFFERS Y SE DECODIFICA UNA SOLA VEZ AL FINAL, y eso no es estilo.
 * La versión anterior hacía `datos += chunk.toString("utf8")` por chunk, que
 * decodifica cada uno por separado — y un carácter multibyte partido en el
 * borde de un chunk TCP se convierte en U+FFFD de los dos lados. En castellano
 * eso no es un caso raro: alcanza una "ñ" o un emoji en el mensaje.
 *
 * El síntoma habría sido el peor posible para una barrera de seguridad: mensajes
 * legítimos fallando la verificación de firma DE FORMA INTERMITENTE, sin patrón
 * visible. Y el paso siguiente que da cualquiera frente a "la firma anda a
 * veces" es desactivar la firma.
 */
async function leerCuerpo(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const partes: Buffer[] = [];
    let bytes = 0;
    let cortado = false;
    req.on("data", (chunk: Buffer) => {
      if (cortado) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cortado = true;
        resolve(null);
        return;
      }
      partes.push(chunk);
    });
    req.on("end", () => {
      if (!cortado) resolve(Buffer.concat(partes).toString("utf8"));
    });
    req.on("error", () => {
      if (!cortado) resolve(null);
    });
  });
}

/**
 * Atiende el webhook de Kapso.
 *
 * SIEMPRE responde 200 salvo que la firma falle. No es descuido: Meta reintenta
 * ante cualquier no-2xx y termina desactivando la suscripción, así que un evento
 * que no sabemos leer tiene que consumirse con un 200 y un motivo, no con un
 * error. La firma es la única excepción porque ahí NO hay evento válido que
 * consumir: lo que llegó no viene de Kapso.
 *
 * Lo que la decisión diga que hay que "delegar" no se ejecuta acá. Este endpoint
 * no llama a Biller ni emite nada: devuelve el ruteo para que lo tome el agente,
 * que es el que tiene al humano adelante.
 *
 * DE QUÉ EMPRESA ES EL EVENTO: DOS SELECTORES QUE TIENEN QUE COINCIDIR.
 *
 * El PATH elige el secreto (ver `rutaWebhookTenant`) y con eso resuelve la
 * empresa antes de tocar el cuerpo. El `phone_number_id` del cuerpo —a qué
 * número le escribieron, ver la decisión 4 de `kapso/webhook.ts`— tiene que
 * apuntar a la MISMA empresa. Que un cuerpo válido para la ruta de A venga con
 * el número de B no es un ataque (para eso habría que tener el secreto de A):
 * es configuración cruzada, alguien que apuntó el webhook de una empresa a la
 * URL de la otra, y sirve todo lo que sigue con los datos equivocados. Se
 * rechaza con log de error aunque la firma sea válida.
 *
 * SIN FALLBACK AL PROCESO. Con empresas configuradas, ni la ruta vieja ni un
 * `phone_number_id` desconocido caen al tenant implícito: el overlay pisa, no
 * completa, y acá vale igual.
 */
async function atenderWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  /** El id que vino en el path, o `null` si entró por la ruta vieja. */
  tenantIdEnPath: string | null,
  config: BillerConfig,
  borradores: BorradorStore | undefined,
  registro: RegistroTenants,
  resolverAmbito: ResolverAmbitoWebhook | undefined,
): Promise<void> {
  const multiEmpresa = registro.tenants.length > 0;

  // 404 para todo lo que no resuelve a una empresa con secreto: es el mismo
  // criterio de la decisión 1 del webhook. Decir "existe pero no autorizado" le
  // cuenta a quien sondea qué empresas hay en este proceso.
  let ambito: AmbitoWebhook | null = null;
  if (!multiEmpresa) {
    // Modo de una sola empresa: EXACTAMENTE el comportamiento de siempre. La
    // ruta por empresa no existe acá — sin registro no hay id que resolver, y
    // aceptar cualquiera sería un alias abierto de la ruta única.
    if (tenantIdEnPath === null) {
      ambito = { tenantId: null, config, ...(borradores === undefined ? {} : { borradores }) };
    }
  } else if (tenantIdEnPath === null) {
    // LA RUTA VIEJA MUERE CUANDO HAY EMPRESAS CONFIGURADAS, y por eso se loguea
    // en error: si sigue entrando tráfico por acá es que quedó un webhook de
    // Kapso apuntando a la URL de antes de migrar. Atenderlo con la config del
    // proceso es el bug entero de vuelta —allowlist de otra empresa, capability
    // mode de otra empresa, borrador que no se encuentra—, y atenderlo
    // "adivinando" por el `phone_number_id` dejaría un camino sin secreto propio
    // por el que entra el cuerpo de cualquier empresa. Que falle ruidoso: un
    // número mudo se diagnostica en una tarde, la contabilidad cruzada no.
    logger.error("kapso.webhook.ruta_sin_empresa", {
      motivo:
        "Llegó un evento a la ruta vieja /kapso/webhook con empresas configuradas. Apuntá Kapso a " +
        "/kapso/webhook/<id de la empresa>.",
    });
  } else {
    const tenant = resolverTenantPorId(registro, tenantIdEnPath);
    if (tenant !== null && resolverAmbito !== undefined) ambito = resolverAmbito(tenant);
  }

  if (ambito === null) {
    responderJson(res, 404, { error: "not_found" });
    return;
  }

  const secreto = ambito.config.kapso?.webhookSecret;
  if (secreto === undefined) {
    // 404, no 403: sin secreto la ruta directamente no existe, y decir "existe
    // pero no autorizado" es contarle a quien sondea que este server tiene un
    // webhook para atacar.
    responderJson(res, 404, { error: "not_found" });
    return;
  }

  if (req.method !== "POST") {
    responderJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const crudo = await leerCuerpo(req, MAX_BODY_BYTES);
  if (crudo === null) {
    responderJson(res, 413, { error: "payload_too_large" });
    return;
  }

  const firma = req.headers[HEADER_FIRMA];
  if (!firmaValida(crudo, Array.isArray(firma) ? firma[0] : firma, secreto)) {
    // Acá también cae el cuerpo firmado con el secreto de OTRA empresa contra
    // esta ruta, y cae sin ningún chequeo especial: el único secreto que esta
    // ruta conoce es el suyo. Ver `rutaWebhookTenant`.
    logger.warn("kapso.webhook.firma_invalida", { bytes: crudo.length, empresa: ambito.tenantId });
    responderJson(res, 401, { error: "invalid_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(crudo);
  } catch {
    responderJson(res, 200, { procesado: false, motivo: "cuerpo no es JSON" });
    return;
  }

  const evento = normalizarEvento(payload);

  // EL SEGUNDO SELECTOR. El path ya eligió la empresa; el número receptor tiene
  // que decir lo mismo. Nada de esto corre en modo de una sola empresa, donde no
  // hay índice contra el cual mapear y el comportamiento no cambia.
  if (multiEmpresa && evento.phone_number_id !== null) {
    const dueno = registro.porPhoneNumberId.get(evento.phone_number_id) ?? null;
    if (dueno === null || dueno.id !== ambito.tenantId) {
      // Nivel ERROR, no info: firma válida más número que no es de esta empresa
      // es un onboarding a medias (falta el `KAPSO_PHONE_NUMBER_ID` en el
      // overlay) o un webhook de Kapso apuntado a la URL de otra. Las dos cosas
      // son un número que atiende mal y nadie se entera. Ruido sería loguear
      // esto en info y descubrirlo cuando el cliente llame.
      logger.error("kapso.webhook.numero_ajeno", {
        empresa_de_la_ruta: ambito.tenantId,
        empresa_del_numero: dueno?.id ?? null,
      });
      // 200 igual, y CERO interpretación: no se mira la allowlist, no se toca el
      // store, no se llama al enrutador. Meta reintenta ante cualquier no-2xx y
      // termina desactivando la suscripción, así que un evento que no sabemos de
      // quién es se consume, no se rebota.
      responderJson(res, 200, {
        procesado: false,
        motivo:
          dueno === null
            ? "El phone_number_id del evento no corresponde a ninguna empresa configurada."
            : "El phone_number_id del evento es de otra empresa que la de la ruta.",
      });
      return;
    }
  }

  const decision = decidirWebhook(evento, {
    capabilityMode: ambito.config.capabilityMode,
    remitentesAutorizados: remitentesAutorizados(ambito.config),
    // Para que una corrección en medio de una carga ("pará, eran 3 no 2") no se
    // autorresponda con el menú. Ver `DecidirOpciones.borradores`. Es el store DE
    // ESTA EMPRESA: el del proceso está salado con otro `cacheId` y no encuentra
    // ninguna clave de sesión de ningún tenant.
    ...(ambito.borradores === undefined ? {} : { borradores: ambito.borradores }),
  });

  // El log lleva el HECHO, nunca el texto: un mensaje entrante puede tener
  // montos, nombres y —si el que escribe quiere— un intento de inyección.
  logger.info("kapso.webhook.evento", {
    empresa: ambito.tenantId,
    tipo: evento.tipo,
    accion: decision.accion,
    remitente: evento.from === null ? null : enmascararTelefono(evento.from),
    via: "interpretacion" in decision ? decision.interpretacion.via : undefined,
  });

  responderJson(res, 200, {
    procesado: decision.accion !== "ignorar",
    accion: decision.accion,
    ...(decision.accion === "rechazar" ? { motivo: decision.motivo } : {}),
    ...(decision.accion === "ignorar" ? { motivo: decision.motivo } : {}),
    ...("interpretacion" in decision
      ? {
          via: decision.interpretacion.via,
          opcion: decision.interpretacion.opcion?.id ?? null,
          tools: "tools" in decision ? decision.tools : [],
          mostrar_menu: decision.interpretacion.mostrar_menu,
          respuesta_sugerida: decision.interpretacion.respuesta_sugerida ?? null,
        }
      : {}),
  });
}

// =============================================================================
// EL REGISTRO DE SESIONES HTTP: TTL + TECHO.
//
// EL MODO DE FALLA QUE ARREGLA. Cada entrada del mapa no es un puntero liviano:
// es un `StreamableHTTPServerTransport` (con su socket) MÁS el `McpServer` que
// se le conectó, con su `ToolContext` colgando. Antes se borraba SOLO en
// `onsessionclosed`, o sea únicamente cuando el cliente cerraba limpio. Un
// túnel que se corta, un Agent Node de Kapso que reconecta, un proceso cliente
// que muere: cada uno dejaba todo eso vivo PARA SIEMPRE. En un despliegue
// multi-empresa de larga vida eso crece monótonamente hasta que el proceso se
// queda sin memoria — y muere el server de facturación de todas las empresas a
// la vez, por culpa de clientes que ya no existen.
//
// MISMO CRITERIO LRU QUE `kapso/borradorStore.ts`: el orden de iteración del Map
// es el de inserción, así que reinsertar en cada acceso convierte "la primera
// clave" en "la menos usada recientemente" y no en "la más vieja de creación".
// Una sesión activa desde hace horas no se puede caer antes que una abandonada
// hace veinte minutos.
//
// DESALOJAR ES CERRAR, NO BORRAR. Sacar la entrada del mapa sin llamar a
// `close()` deja el socket y el McpServer colgados: es exactamente la misma
// fuga con otra cara, y encima invisible porque `sesiones.size` baja.
// =============================================================================

/**
 * Cuánto puede estar una sesión MCP sin que la toquen antes de darla por
 * muerta. 30 minutos por default; se pisa con `BILLER_HTTP_SESSION_TTL_MS`, que
 * `config.ts` valida (un valor no numérico o <= 0 avisa y cae acá: quedarse sin
 * server de facturación por una variable mal tipeada sería peor que ignorarla).
 *
 * EL ARGUMENTO. El caso legítimo más largo es el de un Agent Node de Kapso
 * atendiendo a un almacenero por WhatsApp: pregunta "¿cuánto facturé?", atiende
 * el mostrador, y vuelve a escribir un rato después. Ese hueco es de minutos,
 * a lo sumo una pausa de mediodía; media hora lo cubre con holgura.
 *
 * Y la contra es barata: perder la sesión NO pierde nada del negocio. El
 * `mcp-session-id` no guarda estado fiscal — el borrador de emisión vive en
 * `BorradorStore`, con su propio TTL de 24 h y su propia clave por
 * conversación. Lo único que cuesta un vencimiento es que el cliente rehaga el
 * `initialize`, que es un handshake. Errar por corto se paga con un handshake;
 * errar por largo se paga con el proceso muerto.
 */
export const TTL_SESION_HTTP_MS = DEFAULT_HTTP_SESSION_TTL_MS;

/**
 * Techo de sesiones simultáneas. 200 por default; se pisa con
 * `BILLER_HTTP_MAX_SESSIONS`.
 *
 * No es defensa contra un ataque —para eso está el bearer— sino contra el goteo:
 * clientes que reconectan sin cerrar. 200 sesiones vivas ya es muchísimo para
 * este despliegue (una por Agent Node por empresa, más los clientes de
 * escritorio), así que llegar al techo es señal de que algo está reconectando
 * en loop, y por eso se loguea en `warn`.
 */
export const MAX_SESIONES_HTTP = DEFAULT_HTTP_MAX_SESSIONS;

interface SesionViva {
  transporte: StreamableHTTPServerTransport;
  /** Epoch ms del último uso. Manda para el TTL. */
  tocada: number;
}

/**
 * El mapa de sesiones con TTL y techo LRU.
 *
 * Vive como clase —y exportada— para que el vencimiento se pueda testear con
 * reloj inyectado, sin timers reales ni sleeps, igual que `BorradorStoreMemoria`
 * y el cache de ventanas.
 *
 * LA CLAVE ES `${tenant.id}:${sessionId}` Y ESE PREFIJO ES UNA BARRERA: sin él,
 * un tenant autenticado que presente el `mcp-session-id` de otro recibiría el
 * server del otro. El registro NUNCA arma ni desarma esa clave: la recibe hecha
 * (ver `claveSesion` en el handler) y la trata como opaca, salvo en
 * `cerrarTenant`, que es el único lugar donde el prefijo se usa a propósito.
 */
export class RegistroSesiones {
  private readonly sesiones = new Map<string, SesionViva>();
  private readonly generaciones = new Map<string, number>();
  private readonly ahora: () => number;
  private readonly ttlMs: number;
  private readonly techo: number;

  constructor(opciones: { ahora?: () => number; ttlMs?: number; techo?: number } = {}) {
    this.ahora = opciones.ahora ?? (() => Date.now());
    this.ttlMs = opciones.ttlMs ?? TTL_SESION_HTTP_MS;
    this.techo = opciones.techo ?? MAX_SESIONES_HTTP;
  }

  /** Cuántas sesiones vivas hay. Para logs y tests. */
  get size(): number {
    return this.sesiones.size;
  }

  /**
   * Barrido PEREZOSO de vencidas.
   *
   * A propósito no hay `setInterval`: un timer periódico es maquinaria que hay
   * que acordarse de `unref()` (si no, el proceso no termina nunca) y que
   * trabaja aunque no haya tráfico. Barrer al entrar cada request paga el costo
   * solo cuando alguien está usando el server, que es justo cuando importa.
   *
   * La contra honesta y asumida: sin tráfico las sesiones vencidas quedan en
   * memoria hasta la próxima request. Es un techo acotado (lo que hubiera
   * quedado del último pico) y no crece: sin requests no entran sesiones
   * nuevas.
   */
  barrer(): void {
    const limite = this.ahora() - this.ttlMs;
    for (const [clave, sesion] of this.sesiones) {
      if (sesion.tocada > limite) continue;
      this.cerrarYQuitar(clave, sesion, "vencida");
    }
  }

  /**
   * La sesión de esa clave, o undefined si no existe o venció.
   *
   * Reinsertar en el acceso es lo que hace que el desalojo sea LRU y no FIFO.
   */
  obtener(clave: string): StreamableHTTPServerTransport | undefined {
    const sesion = this.sesiones.get(clave);
    if (sesion === undefined) return undefined;
    if (sesion.tocada <= this.ahora() - this.ttlMs) {
      this.cerrarYQuitar(clave, sesion, "vencida");
      return undefined;
    }
    sesion.tocada = this.ahora();
    this.sesiones.delete(clave); // check-readonly:allow Map.delete para reinsertar y mantener el orden LRU, no es HTTP
    this.sesiones.set(clave, sesion);
    return sesion.transporte;
  }

  /** Registra (o refresca) la sesión y aplica el techo. */
  registrar(clave: string, transporte: StreamableHTTPServerTransport): void {
    this.sesiones.delete(clave); // check-readonly:allow Map.delete para reinsertar al final del orden LRU, no es HTTP
    this.sesiones.set(clave, { transporte, tocada: this.ahora() });
    this.aplicarTecho();
  }

  /** Generación vigente para impedir que una inicialización vieja reviva tras una recarga. */
  generacionTenant(tenantId: string): number {
    return this.generaciones.get(tenantId) ?? 0;
  }

  /**
   * Registra solamente si el tenant no fue revocado desde que empezó el
   * handshake. Si cambió la generación, cierra el transporte tardío.
   */
  registrarSiVigente(
    clave: string,
    tenantId: string,
    generacion: number,
    transporte: StreamableHTTPServerTransport,
  ): boolean {
    if (this.generacionTenant(tenantId) !== generacion) {
      void Promise.resolve(transporte.close()).catch(() => undefined);
      return false;
    }
    this.registrar(clave, transporte);
    return true;
  }

  /** Cierre limpio avisado por el propio transporte (`onsessionclosed`). */
  quitar(clave: string): void {
    this.sesiones.delete(clave); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
  }

  /**
   * Cierra y saca TODAS las sesiones de un tenant.
   *
   * TODAVÍA NO TIENE LLAMADOR, y está a propósito: es la pieza que va a hacer
   * falta el día que se implemente la REVOCACIÓN DE CREDENCIALES. Revocar el
   * token de una empresa sin esto deja abiertas las sesiones que ese token ya
   * había abierto —el bearer se valida al abrir la sesión, no en cada request
   * de una sesión viva—, o sea que la credencial revocada sigue facturando
   * hasta que al cliente se le ocurra desconectarse. Cuesta diez líneas ahora y
   * es la mitad silenciosa del bug después.
   *
   * Devuelve cuántas cerró. Usa el prefijo `${tenantId}:` de la clave, que es
   * justamente para lo que ese prefijo existe.
   */
  cerrarTenant(tenantId: string): number {
    this.generaciones.set(tenantId, this.generacionTenant(tenantId) + 1);
    const prefijo = `${tenantId}:`;
    let cerradas = 0;
    for (const [clave, sesion] of this.sesiones) {
      if (!clave.startsWith(prefijo)) continue;
      this.cerrarYQuitar(clave, sesion, "tenant");
      cerradas += 1;
    }
    return cerradas;
  }

  /** Cierra todo. Lo usa `close()` del handle al bajar el server. */
  cerrarTodo(): void {
    for (const sesion of this.sesiones.values()) void sesion.transporte.close();
    this.sesiones.clear();
  }

  private aplicarTecho(): void {
    while (this.sesiones.size > this.techo) {
      const primera = this.sesiones.entries().next();
      if (primera.done === true) return;
      const [clave, sesion] = primera.value;
      this.cerrarYQuitar(clave, sesion, "techo");
      logger.warn("http.sesion.desalojada_por_techo", { sesiones_activas: this.sesiones.size });
    }
  }

  /**
   * El único camino de salida que además CIERRA. Ver el encabezado: borrar sin
   * cerrar deja el socket y el McpServer colgados.
   *
   * El `close()` es asíncrono y su rechazo se ignora a propósito: la sesión ya
   * está desahuciada, y una promesa rechazada sin catch tumba el proceso.
   */
  private cerrarYQuitar(clave: string, sesion: SesionViva, motivo: string): void {
    this.sesiones.delete(clave); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
    void Promise.resolve(sesion.transporte.close()).catch((err: unknown) => {
      logger.warn("http.sesion.cierre_fallido", {
        motivo,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Arranca el server MCP sobre HTTP.
 *
 * `crearServidorMcp` se invoca UNA VEZ POR SESIÓN: cada cliente necesita su
 * propia instancia de McpServer + transporte. Compartir una sola instancia
 * entre conexiones mezcla el estado de sesión de clientes distintos.
 *
 * Recibe el TENANT de la request (null en modo de una sola empresa) porque la
 * empresa se decide en la autenticación, no antes: el token es a la vez la
 * credencial y el selector. Ver `src/tenants/acceso.ts`.
 *
 * OJO CON LA SESIÓN: el `mcp-session-id` queda ligado al server que se creó con
 * el token de la primera request. Una sesión no cambia de empresa a mitad de
 * camino, que es lo correcto — pero significa que el token que importa es el de
 * la request que ABRE la sesión.
 */
export async function iniciarTransporteHttp(
  config: BillerConfig,
  crearServidorMcp: (tenant: Tenant | null) => McpServer,
  registro: RegistroTenantsVigente = SIN_TENANTS,
  /**
   * El store de borradores del contexto base, para que el webhook sepa si la
   * conversación tiene una emisión a medio cargar. Opcional a propósito: los
   * llamadores que no lo pasen (los tests, sobre todo) siguen andando igual, y
   * el webhook se comporta como antes.
   *
   * Es el store del contexto de UNA empresa porque el webhook ya lo es: se
   * atiende con `config`, no con el tenant de la request. Si algún día el
   * webhook aprende de tenants, este parámetro se muda con él.
   */
  borradores?: BorradorStore,
  /**
   * Costura para los tests: permite inyectar un registro de sesiones con reloj
   * falso. En producción no se pasa y se usa el default.
   *
   * `resolverAmbitoWebhook` sí se pasa en producción: es cómo el webhook consigue
   * la config y el BorradorStore DE CADA EMPRESA. Lo inyecta `index.ts`, que es
   * el dueño del cache de contextos por tenant. Sin él, con empresas
   * configuradas, ninguna ruta de webhook resuelve y todas dan 404 — que es el
   * lado correcto para fallar: mudo, no cruzado.
   */
  opciones?: { registroSesiones?: RegistroSesiones; resolverAmbitoWebhook?: ResolverAmbitoWebhook },
): Promise<HttpTransportHandle> {
  // TTL + techo LRU. Ver el encabezado de `RegistroSesiones`: sin esto, cada
  // cliente que se cae sin cerrar limpio deja un transporte y un McpServer vivos
  // para siempre.
  // Los dos números salen de la config validada (`BILLER_HTTP_SESSION_TTL_MS`,
  // `BILLER_HTTP_MAX_SESSIONS`), no de `process.env` leído acá: son parámetros
  // del PROCESO y no de una empresa, pero leerlos sueltos los dejaba fuera de la
  // validación y de los warnings, que es el camino por el que una variable se
  // vuelve imposible de pisar.
  const sesiones =
    opciones?.registroSesiones ??
    new RegistroSesiones({ ttlMs: config.httpSessionTtlMs, techo: config.httpMaxSessions });

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Liveness: sin auth y sin ningún dato del negocio.
      if (url.pathname === HEALTH_PATH) {
        responderJson(res, 200, { status: "ok", transport: "http" });
        return;
      }

      // Una request conserva UN snapshot coherente de principio a fin. La
      // siguiente asignación del holder no puede mezclar auth de un registro
      // con el webhook o el tenant de otro.
      const registroActual = snapshotRegistro(registro);

      // El webhook va ANTES de la autenticación bearer: su credencial es otra
      // (la firma HMAC del cuerpo) porque quien llama es Kapso, no un cliente
      // MCP. Meterlo detrás del bearer significaría ponerle nuestro token a un
      // tercero, que es exactamente lo que la firma evita.
      if (url.pathname === WEBHOOK_PATH || url.pathname.startsWith(`${WEBHOOK_PATH}/`)) {
        // El id de empresa sale del PATH, que es lo que selecciona el secreto.
        // Un path vacío (`/kapso/webhook` o `/kapso/webhook/`) es la ruta vieja.
        const resto = url.pathname.slice(WEBHOOK_PATH.length + 1);
        await atenderWebhook(
          req,
          res,
          resto === "" ? null : resto,
          config,
          borradores,
          registroActual,
          opciones?.resolverAmbitoWebhook,
        );
        return;
      }

      if (url.pathname !== MCP_PATH) {
        responderErrorRpc(res, 404, `Ruta no encontrada. El endpoint MCP es ${MCP_PATH}.`);
        return;
      }

      const auth = autenticarConTenants(req, config.httpAuthToken, registroActual);
      if (!auth.ok) {
        // No se loguea el token presentado, ni siquiera un prefijo.
        logger.warn("http.auth.rechazado", { status: auth.status, path: url.pathname });
        res.setHeader("www-authenticate", 'Bearer realm="biller-mcp"');
        responderErrorRpc(res, auth.status, auth.message);
        return;
      }

      try {
        const sessionId = req.headers["mcp-session-id"];
        const sessionIdRaw = Array.isArray(sessionId) ? sessionId[0] : sessionId;

        // LA CLAVE DE SESIÓN LLEVA EL TENANT ADELANTE.
        //
        // Sin eso, el mapa se indexa solo por el `mcp-session-id` que manda el
        // cliente, y un tenant autenticado que presente el id de sesión de OTRO
        // recibe el server de ese otro — o sea, la contabilidad de otra empresa,
        // con su propio token válido en la mano.
        //
        // El id es un UUID aleatorio, así que adivinarlo no es viable; pero
        // aparece en headers, en trazas y en cualquier log de proxy, y "es
        // difícil de adivinar" no es el mismo argumento que "no sirve aunque lo
        // tengas". Esto último cuesta una interpolación.
        const sessionKey =
          sessionIdRaw === undefined ? undefined : `${auth.tenant?.id ?? "-"}:${sessionIdRaw}`;
        const tenantIdSesion = auth.tenant?.id ?? "-";
        const generacionSesion = sesiones.generacionTenant(tenantIdSesion);

        // Barrido perezoso: se paga en el tráfico, no en un timer que además
        // habría que `unref()` para no impedir que el proceso termine.
        sesiones.barrer();

        let transport = sessionKey !== undefined ? sesiones.obtener(sessionKey) : undefined;

        if (sessionKey !== undefined && transport === undefined) {
          responderErrorRpc(res, 404, "Sesión MCP no encontrada.");
          return;
        }

        if (transport === undefined) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              const registrada = sesiones.registrarSiVigente(
                `${auth.tenant?.id ?? "-"}:${id}`,
                tenantIdSesion,
                generacionSesion,
                transport!,
              );
              if (!registrada) {
                logger.warn("http.sesion.revocada_durante_inicio", { empresa: tenantIdSesion });
                return;
              }
              logger.info("http.sesion.abierta", { sesiones_activas: sesiones.size });
            },
            onsessionclosed: (id) => {
              // Cierre limpio: el transporte ya se está cerrando solo, acá solo
              // se saca la entrada.
              sesiones.quitar(`${auth.tenant?.id ?? "-"}:${id}`);
              logger.info("http.sesion.cerrada", { sesiones_activas: sesiones.size });
            },
            // Sin esto, un sitio malicioso en el navegador del operador puede
            // hablarle a 127.0.0.1 vía DNS rebinding.
            enableDnsRebindingProtection: true,
            // Detrás de un túnel o un dominio propio, el `Host` que llega es el
            // PÚBLICO, no el de escucha: sin declararlo, Kapso recibe
            // "Invalid Host header" antes de que se ejecute ninguna tool. Se
            // declara el nombre en vez de apagar la protección — apagarla vale
            // para cualquier atacante; declarar un nombre vale para ese nombre.
            // El host público puede venir con o sin puerto según el proxy.
            allowedHosts: [
              `${config.httpHost}:${config.httpPort}`,
              `localhost:${config.httpPort}`,
              `127.0.0.1:${config.httpPort}`,
              ...config.httpAllowedHosts.flatMap((h) => [h, `${h}:443`, `${h}:${config.httpPort}`]),
            ],
          });

          const server = crearServidorMcp(auth.tenant);
          await server.connect(
            conDialectoLimpio(transport, { quitarOutputSchema: config.wireLiviano }),
          );
        }

        await transport.handleRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("http.request.error", { message });
        if (!res.headersSent) {
          responderErrorRpc(res, 500, "Error interno del transporte HTTP.");
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const direccion = httpServer.address();
  const puerto = typeof direccion === "object" && direccion !== null ? direccion.port : config.httpPort;

  return {
    port: puerto,
    cerrarSesionesTenants: (tenantIds) => {
      let cerradas = 0;
      for (const tenantId of new Set(tenantIds)) cerradas += sesiones.cerrarTenant(tenantId);
      return cerradas;
    },
    close: () =>
      new Promise<void>((resolve) => {
        sesiones.cerrarTodo();
        httpServer.close(() => resolve());
      }),
  };
}
