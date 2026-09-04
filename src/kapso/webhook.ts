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

/**
 * Los DOS headers con los que puede venir la firma del cuerpo, en orden de
 * preferencia.
 *
 * POR QUÉ SON DOS, Y POR QUÉ ESTO ERA UN BUG MUDO.
 *
 * `x-hub-signature-256` es el header de Meta, y es el que llega cuando el
 * webhook se conecta directo contra la Cloud API. Pero un webhook registrado
 * por la API de plataforma de Kapso —que es el camino multi-empresa, el mismo
 * que hace falta para dar de alta a las demás empresas de Biller— viene firmado
 * por Kapso con `X-Webhook-Signature`: HMAC-SHA256 en hexadecimal, sin el
 * prefijo `sha256=`, sobre los BYTES CRUDOS del cuerpo (verificado el
 * 2026-09-03 contra docs.kapso.ai/docs/platform/webhooks/security).
 *
 * Leyendo solo el primero, un evento firmado por Kapso llega sin firma
 * reconocible, se responde 401 y el chat queda MUDO — el peor modo de falla de
 * este proyecto, y el más difícil de diagnosticar porque el log dice
 * "firma_invalida" y todo lo demás parece estar bien.
 *
 * Aceptar los dos nombres NO afloja nada: el secreto sigue siendo el mismo y la
 * firma se sigue calculando sobre el mismo cuerpo crudo. Lo único que cambia es
 * de qué renglón del header se lee el hexadecimal.
 */
export const HEADERS_FIRMA = ["x-webhook-signature", "x-hub-signature-256"] as const;

/** El header histórico. Se conserva porque lo usan los tests y la doc. */
export const HEADER_FIRMA = "x-hub-signature-256";

/** Tope del cuerpo aceptado. Un webhook de WhatsApp entra holgado en 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * EL TECHO DEL TEXTO ENTRANTE LO PONE EL SERVER, NO META (issue 12).
 *
 * `normalizarEvento` copiaba `text.body` sin cap —hasta 1 MB, el tope de
 * `MAX_BODY_BYTES`— y se lo pasaba tal cual a `interpretarMensaje`, que es
 * SÍNCRONO. Medido: un mensaje de 1 MB bloquea el event loop casi 6
 * segundos, y durante esos segundos no se atiende a nadie más.
 *
 * WhatsApp real ya corta un mensaje de texto en 4096 caracteres —por eso la
 * severidad es baja: para llegar acá hace falta firma válida y remitente
 * autorizado, y el cliente oficial nunca manda más—, pero "hoy el techo lo
 * pone Meta" es exactamente el supuesto que no hay que dejar en pie: un
 * remitente autorizado que use la Cloud API directo, sin el cliente oficial
 * de por medio, puede mandar cualquier cosa que entre en el `MAX_BODY_BYTES`
 * del cuerpo entero.
 */
export const MAX_TEXTO_ENTRANTE = 4096;

/**
 * Los ids de botón y de fila NO son texto libre —los emitimos nosotros—, pero
 * llegan de vuelta en el mismo campo (`texto`) y por el mismo camino
 * síncrono, así que se cortan con los límites reales de la Cloud API: 256
 * caracteres para el id de un botón, 200 para el id de una fila de lista.
 */
export const MAX_ID_BOTON = 256;
export const MAX_ID_FILA = 200;

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

/**
 * Saca la firma de los headers de una request, mire por donde mire.
 *
 * Devuelve TODAS las candidatas y no la primera: si un proxy agrega un header
 * vacío, quedarse con él descartaría la firma buena que venía en el otro.
 */
export function firmasDeHeaders(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const out: string[] = [];
  for (const nombre of HEADERS_FIRMA) {
    const bruto = headers[nombre];
    const valor = Array.isArray(bruto) ? bruto[0] : bruto;
    if (typeof valor === "string" && valor.trim() !== "") out.push(valor);
  }
  return out;
}

/**
 * true si ALGUNA de las firmas presentes es válida.
 *
 * "Alguna" y no "todas": los dos headers son el mismo HMAC sobre el mismo
 * cuerpo con el mismo secreto, así que producir uno válido ya exige conocer el
 * secreto. Exigir que coincidan los dos solo agregaría formas de quedar mudo.
 */
export function algunaFirmaValida(
  cuerpoCrudo: string,
  headers: Record<string, string | string[] | undefined>,
  secreto: string,
): boolean {
  const firmas = firmasDeHeaders(headers);
  if (firmas.length === 0) return false;
  return firmas.some((f) => firmaValida(cuerpoCrudo, f, secreto));
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
 * Corta un texto al máximo indicado, ANTES de que le llegue a
 * `interpretarMensaje` (síncrono). Ver `MAX_TEXTO_ENTRANTE`.
 *
 * Se corta por UNIDADES DE CÓDIGO UTF-16 (`.slice`, no bytes): es lo mismo
 * que hace WhatsApp al contar "caracteres", y cortar a mitad de un par
 * subrogado (un emoji de dos unidades) es un riesgo menor comparado con
 * bloquear el proceso — la parte cortada de más, en el peor caso, es un solo
 * carácter mal formado al final de una lista que igual no iba a matchear
 * nada por ese pedacito.
 */
function recortar(valor: string | null, max: number): string | null {
  return valor === null || valor.length <= max ? valor : valor.slice(0, max);
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
    return { ...base, tipo: "texto", texto: recortar(texto(t?.body), MAX_TEXTO_ENTRANTE) };
  }

  if (mensaje.type === "interactive") {
    const i = mensaje.interactive as Record<string, unknown> | undefined;
    const boton = i?.button_reply as Record<string, unknown> | undefined;
    const fila = i?.list_reply as Record<string, unknown> | undefined;
    // Lo que se interpreta es el ID, no el título: el id lo emitimos nosotros y
    // es lo que el enrutador sabe leer. El título es texto para humanos y puede
    // repetirse entre opciones.
    if (boton !== undefined) return { ...base, tipo: "boton", texto: recortar(texto(boton.id), MAX_ID_BOTON) };
    if (fila !== undefined) return { ...base, tipo: "lista", texto: recortar(texto(fila.id), MAX_ID_FILA) };
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
/**
 * Lo que se contesta ante un audio, una foto, un sticker o una ubicación.
 *
 * Corto y con la salida adelante: el que dictó un audio quiere resolver algo,
 * no leer una explicación de por qué no se puede.
 */
export const TEXTO_TIPO_NO_SOPORTADO =
  "Todavía no puedo escuchar audios ni leer imágenes 🙈 Escribime en un mensaje qué necesitás " +
  '—por ejemplo "facturale 2 bolsas a 610 a Pérez" o "¿quién me debe?"— y lo hago.';

const VIAS_AUTORESPONDIBLES: ReadonlySet<Interpretacion["via"]> = new Set([
  "saludo",
  "cortesia",
  "ambiguo",
  "no_disponible",
  "desconocido",
]);

/**
 * Lo que contesta una cancelación ESCRITA ("pará", "cancelá", "dejá") cuando
 * hay un borrador vivo. Texto exacto del issue 18: es lo único que ve el
 * usuario, así que no lo redacta el agente.
 */
const TEXTO_CANCELACION_EN_FLUJO =
  "Listo, dejé la factura sin hacer y no emití nada. Si querés arrancar otra, tocá " +
  '"Emitir un comprobante" o escribime "menú".';

export type DecisionWebhook =
  | { accion: "ignorar"; motivo: string }
  | { accion: "rechazar"; motivo: "no_autorizado" | "sin_allowlist"; mensaje: string }
  | {
      accion: "responder";
      from: string;
      /**
       * Cómo se leyó el mensaje. `null` cuando no había nada que leer —un audio,
       * una foto— y se contesta igual para no dejar al usuario en silencio.
       */
      interpretacion: Interpretacion | null;
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
 * NO MANDA MENSAJES NI LLAMA A BILLER — esa parte de la decisión 2 del
 * encabezado sigue entera. La única mutación que hace es borrar un borrador
 * PROPIO cuando la cancelación escrita ("pará", "cancelá") llega con un
 * borrador vivo (issue 18): es la misma lectura de estado propio que ya
 * justifica `borradores` más arriba, llevada un paso más — borrar lo que este
 * mismo server guardó no es ni tocar plata ni escribir en Biller. Fuera de
 * ese caso puntual, sigue siendo determinística: mismo evento, misma
 * decisión.
 */
export function decidirWebhook(evento: EventoEntrante, opciones: DecidirOpciones): DecisionWebhook {
  if (evento.tipo === "estado") {
    return { accion: "ignorar", motivo: "Es un acuse de entrega/lectura, no un mensaje." };
  }
  // Sin `from` no hay a quién contestarle ni contra qué chequear la allowlist.
  if (evento.from === null) {
    return { accion: "ignorar", motivo: "El evento no dice quién escribió." };
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

  // UN AUDIO O UNA FOTO NO PUEDEN TERMINAR EN SILENCIO.
  //
  // Va DESPUÉS de la allowlist a propósito: contestarle "no puedo leer audios"
  // a un desconocido ya confirma que este número atiende a esta empresa, que es
  // exactamente lo que la barrera de entrada evita. A un autorizado, en cambio,
  // el silencio es el peor modo de falla del proyecto: dicta un mensaje —que en
  // Uruguay es la forma más común de escribir— y no recibe nada, que es
  // indistinguible de "está roto".
  //
  // No intentamos adivinar el contenido: se dice qué se puede hacer y se sigue.
  if (evento.texto === null) {
    return {
      accion: "responder",
      from: evento.from,
      interpretacion: null,
      respuesta: TEXTO_TIPO_NO_SOPORTADO,
      mostrar_menu: false,
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

  // CANCELACIÓN ESCRITA CON BORRADOR VIVO: EL WEBHOOK LA RESUELVE SOLO.
  //
  // Fuera de flujo, `cancelacion` sigue sin estar en `VIAS_AUTORESPONDIBLES`
  // y se delega siempre: el agente puede tener otra confirmación pendiente
  // (un recibo, por ejemplo) que no es cosa nuestra cancelar sin verla. Pero
  // con un borrador vivo el webhook YA SABE qué hay pendiente —es una emisión
  // guiada, la misma que le permite leer `enFlujo`— y contestar "no entendí"
  // o delegar a un agente que no la va a resolver bien es el callejón que
  // encontró la auditoría del flujo (docs/FLUJO_WHATSAPP.md §2.6, Z1).
  if (interpretacion.via === "cancelacion" && enFlujo && opciones.borradores !== undefined) {
    opciones.borradores.borrar(opciones.borradores.clave(evento.from));
    return {
      accion: "responder",
      from: evento.from,
      interpretacion,
      respuesta: TEXTO_CANCELACION_EN_FLUJO,
      mostrar_menu: false,
    };
  }

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
