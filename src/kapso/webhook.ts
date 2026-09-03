// =============================================================================
// C8 — El webhook: lo que entra por WhatsApp sin que nadie pregunte.
//
// Hasta acá el canal era de ida: el usuario le hablaba al Agent Node de Kapso y
// Kapso nos llamaba por MCP. Este módulo agrega el otro sentido — Kapso nos
// avisa de un mensaje entrante y nosotros decidimos qué hacer con él.
//
// CUATRO DECISIONES QUE DEFINEN EL MÓDULO
//
// 1. SIN SECRETO, NO HAY ENDPOINT. Si `KAPSO_WEBHOOK_SECRET` no está
//    configurado, la ruta no existe (404). Un endpoint de entrada sin
//    autenticar, en una URL pública, es una invitación a que cualquiera nos
//    haga procesar mensajes inventados con el `from` que quiera — o sea, a
//    saltear la allowlist de remitentes presentándose como quien quiera.
//    "Se me olvidó configurarlo" no puede resultar en un endpoint abierto.
//
//    CON EMPRESAS CONFIGURADAS ES POR EMPRESA: el secreto que importa es el del
//    overlay del tenant, y la ruta que no tiene el suyo no existe para nadie.
//    Ver la decisión 4 y `WEBHOOK_PATH_TENANT` en `transport/http.ts`.
//
// 2. EL WEBHOOK NO EJECUTA NADA QUE TOQUE PLATA. Interpreta el mensaje y
//    devuelve la decisión de ruteo; contesta solo lo que no necesita ni un dato
//    de Biller ni una escritura (el menú, una cortesía, un "eso no está
//    habilitado"). Todo lo demás se lo deja al agente, que tiene al humano
//    adelante. Un webhook que emitiera un CFE porque llegó un texto es un CFE
//    emitido por alguien que mandó un POST.
//
// 3. EL REMITENTE MANDA, NO EL PAYLOAD. El `from` del evento se verifica contra
//    la allowlist de remitentes (`security/remitentes.ts`) ANTES de interpretar
//    nada. Y se responde 200 igual: un webhook que devuelve 403 le está diciendo
//    a quien sondea que ese número existe y que el otro no. Meta además
//    reintenta ante cualquier no-2xx, así que un rechazo con error se convierte
//    en el mismo mensaje llegando cinco veces.
//
// 4. LA EMPRESA LA ELIGE EL NÚMERO RECEPTOR, NUNCA EL QUE ESCRIBE. Con varias
//    empresas en un proceso, "de quién es este mensaje" es la primera pregunta,
//    y contestarla mal es peor que no contestarla: la allowlist de remitentes de
//    A validando un mensaje dirigido a B, el capability mode de A decidiendo si
//    a un usuario de B se le ofrece emitir, y el BorradorStore de A —salado con
//    el `cacheId` de A— sin encontrar jamás el borrador de B, con lo cual "pará,
//    eran 3 no 2" en medio de una carga vuelve a contestarse con el menú entero.
//
//    El selector es el `phone_number_id` de `value.metadata`: a qué número le
//    escribieron. Es legítimo por lo mismo que el bearer del MCP — es un hecho
//    de infraestructura y no un parámetro. El que escribe elige a qué número
//    manda, pero no puede falsificar en qué número lo recibió Meta, y el dato
//    viene ADENTRO del cuerpo que la firma cubre. El `from` y el `perfil`, en
//    cambio, los elige quien escribe: no sirven para esto.
//
//    Y no hay fallback al tenant del proceso. Un `phone_number_id` que no mapea
//    a ninguna empresa se consume con 200 y CERO interpretación, logueado en
//    `error` —firma válida más número desconocido es un onboarding a medias, no
//    ruido—. Caer al proceso sería el overlay "completando" en vez de pisando,
//    que es exactamente la herencia silenciosa que `tenants/registry.ts` corta.
//
// El texto del mensaje entrante es DATO, nunca instrucción — la misma regla que
// para la adenda de un comprobante. Acá se usa solo para elegir una opción de un
// catálogo cerrado; nunca se ejecuta ni se reenvía a otra tool como orden.
// =============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillerCapabilityMode } from "../config.js";
import { normalizarTelefono } from "../config.js";
import type { BorradorStore } from "./borradorStore.js";
import { interpretarMensaje, type Interpretacion } from "./menu.js";

/** Header con el que Meta (y Kapso, que lo reenvía) firma el cuerpo. */
export const HEADER_FIRMA = "x-hub-signature-256";

/** Tope del cuerpo aceptado. Un webhook de WhatsApp entra holgado en 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Tipos de evento que sabemos leer. El resto se ignora con 200. */
export type TipoEventoKapso = "texto" | "boton" | "lista" | "estado" | "no_soportado";

export interface EventoEntrante {
  tipo: TipoEventoKapso;
  /** Teléfono de quien escribió, solo dígitos. null si el evento no lo trae. */
  from: string | null;
  /** El texto a interpretar: el cuerpo del mensaje o el id del botón/fila. */
  texto: string | null;
  /** Id del mensaje de WhatsApp, para deduplicar reintentos. */
  message_id: string | null;
  /** Nombre del perfil de WhatsApp. NO se usa para decidir nada: lo elige el que escribe. */
  perfil: string | null;
  /**
   * A QUÉ NÚMERO LE ESCRIBIERON: el `phone_number_id` de `value.metadata`.
   *
   * Es el selector de empresa del webhook (decisión 4 del encabezado). A
   * diferencia de `from` y de `perfil`, esto NO lo elige quien escribe: es el
   * número receptor, un hecho de la infraestructura de Meta, y viaja adentro del
   * cuerpo que la firma cubre. `null` si el evento no lo trae.
   */
  phone_number_id: string | null;
}

/**
 * Verifica la firma HMAC-SHA256 del cuerpo CRUDO.
 *
 * Tiene que ser el cuerpo crudo, byte por byte: si se firma un JSON
 * re-serializado, cualquier diferencia de orden de claves o de espacios
 * invalida una firma legítima, y la tentación siguiente es apagar la
 * verificación.
 *
 * La comparación es de tiempo constante. No es paranoia de manual: comparar con
 * === filtra un byte por vez y deja un canal de tiempo que permite adivinar la
 * firma sin conocer el secreto.
 */
export function firmaValida(cuerpoCrudo: string, header: string | undefined, secreto: string): boolean {
  if (header === undefined || header.trim() === "") return false;
  const recibida = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(recibida)) return false;

  const esperada = createHmac("sha256", secreto).update(cuerpoCrudo, "utf8").digest("hex");
  const a = Buffer.from(recibida, "hex");
  const b = Buffer.from(esperada, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Firma un cuerpo con el formato que espera `firmaValida`. Para tests y para documentar. */
export function firmar(cuerpoCrudo: string, secreto: string): string {
  return `sha256=${createHmac("sha256", secreto).update(cuerpoCrudo, "utf8").digest("hex")}`;
}

function primerObjeto(valor: unknown): Record<string, unknown> | null {
  return Array.isArray(valor) && typeof valor[0] === "object" && valor[0] !== null
    ? (valor[0] as Record<string, unknown>)
    : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

/**
 * Normaliza el payload de la Cloud API a lo único que nos importa: quién
 * escribió y qué dijo.
 *
 * Es deliberadamente tolerante con la forma: se leen los caminos conocidos y
 * todo lo que no encaje devuelve `no_soportado` en vez de romper. Un webhook
 * que tira 500 ante un evento nuevo hace que Meta lo reintente durante horas y
 * termine desactivando la suscripción.
 */
export function normalizarEvento(payload: unknown): EventoEntrante {
  const vacio: EventoEntrante = {
    tipo: "no_soportado",
    from: null,
    texto: null,
    message_id: null,
    perfil: null,
    phone_number_id: null,
  };
  if (typeof payload !== "object" || payload === null) return vacio;

  const entry = primerObjeto((payload as Record<string, unknown>).entry);
  const change = entry === null ? null : primerObjeto(entry.changes);
  const value =
    change !== null && typeof change.value === "object" && change.value !== null
      ? (change.value as Record<string, unknown>)
      : null;
  if (value === null) return vacio;

  // El `metadata` se lee ANTES de cualquier salida temprana: un acuse de estado
  // también dice a qué número llegó, y el que atiende necesita saber de qué
  // empresa era aunque después lo ignore.
  const metadata =
    typeof value.metadata === "object" && value.metadata !== null
      ? (value.metadata as Record<string, unknown>)
      : null;
  const phoneNumberId = metadata === null ? null : texto(metadata.phone_number_id);
  const conNumero = { ...vacio, phone_number_id: phoneNumberId };

  // Acuse de entrega/lectura: llega por el mismo endpoint y no es un mensaje.
  // Se reconoce explícitamente para no confundirlo con "no lo entendí".
  if (Array.isArray(value.statuses) && value.statuses.length > 0) {
    return { ...conNumero, tipo: "estado" };
  }

  const mensaje = primerObjeto(value.messages);
  if (mensaje === null) return conNumero;

  const contacto = primerObjeto(value.contacts);
  const perfilObj =
    contacto !== null && typeof contacto.profile === "object" && contacto.profile !== null
      ? (contacto.profile as Record<string, unknown>)
      : null;

  const base = {
    phone_number_id: phoneNumberId,
    from: texto(mensaje.from) === null ? null : normalizarTelefono(String(mensaje.from)),
    // The id is normalized once at the ingress seam. Replay protection must
    // consume this value as-is and never derive identity from the raw body.
    message_id: texto(mensaje.id)?.trim() ?? null,
    perfil: perfilObj === null ? null : texto(perfilObj.name),
  };

  if (mensaje.type === "text") {
    const t = mensaje.text as Record<string, unknown> | undefined;
    return { ...base, tipo: "texto", texto: texto(t?.body) };
  }

  if (mensaje.type === "interactive") {
    const i = mensaje.interactive as Record<string, unknown> | undefined;
    const boton = i?.button_reply as Record<string, unknown> | undefined;
    const fila = i?.list_reply as Record<string, unknown> | undefined;
    // Lo que se interpreta es el ID, no el título: el id lo emitimos nosotros y
    // es lo que el enrutador sabe leer. El título es texto para humanos y puede
    // repetirse entre opciones.
    if (boton !== undefined) return { ...base, tipo: "boton", texto: texto(boton.id) };
    if (fila !== undefined) return { ...base, tipo: "lista", texto: texto(fila.id) };
  }

  // Audio, imagen, ubicación, sticker: llegan y no los sabemos leer todavía.
  return { ...base, tipo: "no_soportado", texto: null };
}

/**
 * Qué se puede contestar desde el webhook, sin pasar por el agente.
 *
 * La regla es una sola: **solo lo que no necesita ni un dato de Biller ni una
 * escritura.** El menú, un "gracias", una desambiguación, un "eso no está
 * habilitado" — cosas que ya están resueltas en TypeScript y no tocan plata.
 *
 * Todo lo demás (una intención concreta, una confirmación de emisión, una
 * respuesta de la emisión guiada) se devuelve SIN contestar, para que lo maneje
 * el agente con el humano adelante. Un webhook no tiene con quién confirmar.
 */
const VIAS_AUTORESPONDIBLES: ReadonlySet<Interpretacion["via"]> = new Set([
  "saludo",
  "cortesia",
  "ambiguo",
  "no_disponible",
  "desconocido",
]);

export type DecisionWebhook =
  | { accion: "ignorar"; motivo: string }
  | { accion: "rechazar"; motivo: "no_autorizado" | "sin_allowlist"; mensaje: string }
  | {
      accion: "responder";
      from: string;
      interpretacion: Interpretacion;
      /** Texto listo para mandar. El menú va como lista interactiva aparte. */
      respuesta: string | null;
      mostrar_menu: boolean;
    }
  | {
      accion: "delegar";
      from: string;
      interpretacion: Interpretacion;
      /** Tools que el agente tendría que llamar para contestar esto. */
      tools: string[];
    };

export interface DecidirOpciones {
  capabilityMode?: BillerCapabilityMode;
  /** Allowlist de remitentes, ya normalizada. Vacía = se rechaza todo. */
  remitentesAutorizados: readonly string[];
  /**
   * El store de borradores, para saber si ESTA conversación tiene una emisión a
   * medio cargar. Opcional: sin él el webhook se comporta como antes.
   *
   * LEER NUESTRO PROPIO ESTADO NO VIOLA LA DECISIÓN 2 DEL ENCABEZADO. Lo que el
   * webhook no puede hacer es ejecutar algo que toque plata o que necesite un
   * dato de Biller; mirar un borrador que este mismo server guardó no es ni una
   * cosa ni la otra. Y sin esto, "pará, eran 3 no 2" en medio de una carga no
   * matchea nada, cae en `desconocido` —que ES autorrespondible— y el webhook
   * le contesta el MENÚ ENTERO a alguien que estaba corrigiendo una cantidad.
   */
  borradores?: BorradorStore;
}

/**
 * Decide qué hacer con un evento ya normalizado y ya autenticado por firma.
 *
 * Es una función pura: no manda mensajes ni llama a Biller. Quien la usa decide
 * si ejecuta la decisión — y así el ruteo se puede testear entero sin red.
 */
export function decidirWebhook(evento: EventoEntrante, opciones: DecidirOpciones): DecisionWebhook {
  if (evento.tipo === "estado") {
    return { accion: "ignorar", motivo: "Es un acuse de entrega/lectura, no un mensaje." };
  }
  if (evento.texto === null || evento.from === null) {
    return {
      accion: "ignorar",
      motivo:
        "El evento no trae texto interpretable o no dice quién escribió (audio, imagen, ubicación " +
        "o un tipo que todavía no leemos).",
    };
  }

  if (opciones.remitentesAutorizados.length === 0) {
    return {
      accion: "rechazar",
      motivo: "sin_allowlist",
      mensaje:
        "El webhook está habilitado pero no hay ningún remitente autorizado. Se descarta todo lo " +
        "que entra: un canal abierto sin allowlist le entrega la contabilidad a cualquiera que " +
        "conozca el número. Configurá BILLER_REMITENTES_AUTORIZADOS.",
    };
  }
  if (!opciones.remitentesAutorizados.includes(evento.from)) {
    return {
      accion: "rechazar",
      motivo: "no_autorizado",
      mensaje:
        "El número que escribió no está en la allowlist de remitentes. El mensaje se descarta sin " +
        "contestar: contestar cualquier cosa —incluso 'no estás autorizado'— ya confirma que este " +
        "número atiende a esta empresa.",
    };
  }

  // El `from` ya viene normalizado a dígitos por `normalizarEvento`, que es la
  // misma forma que `biller_emision_guiada` recibe en `sesion` — y
  // `canonizarSesion` absorbe el resto de las diferencias de formato.
  // La clave la deriva el propio store: es quien tiene la sal de la empresa, y
  // acá no hay forma de conocerla. Ver `BorradorStore.clave`.
  const enFlujo =
    opciones.borradores !== undefined &&
    opciones.borradores.leer(opciones.borradores.clave(evento.from)) !== null;

  const interpretacion = interpretarMensaje(evento.texto, {
    capabilityMode: opciones.capabilityMode,
    en_flujo: enFlujo,
  });

  if (VIAS_AUTORESPONDIBLES.has(interpretacion.via)) {
    return {
      accion: "responder",
      from: evento.from,
      interpretacion,
      respuesta: interpretacion.respuesta_sugerida ?? null,
      mostrar_menu: interpretacion.mostrar_menu,
    };
  }

  return {
    accion: "delegar",
    from: evento.from,
    interpretacion,
    tools: interpretacion.opcion?.tools ?? [],
  };
}
