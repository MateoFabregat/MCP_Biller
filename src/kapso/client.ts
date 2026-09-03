// =============================================================================
// Cliente de la API de Kapso (WhatsApp).
//
// Cuatro salidas, todas por el mismo endpoint de mensajes salvo la subida de
// archivos:
//   POST {base}/meta/whatsapp/v24.0/{phone_number_id}/messages   texto,
//                                                                interactivo,
//                                                                documento
//   POST {base}/meta/whatsapp/v24.0/{phone_number_id}/media      subir archivo
//   X-API-Key: <project_api_key>
//
// ESTE ARCHIVO VIVE EN `kapso/`, NO EN `write/`, y hace POST a propósito.
//
// La capa `write/` tiene una semántica muy concreta: emite comprobantes fiscales
// ante DGI. Esos SÍ se pueden corregir (una nota de crédito anula, una nota de
// débito revierte la anulación), y su gate está calibrado para eso.
//
// Un mensaje de WhatsApp es al revés: no tiene efecto fiscal, pero es
// GENUINAMENTE irreversible. No existe la nota de crédito de un mensaje ya
// entregado a un tercero. Por eso su control no es un ciclo de confirmación
// sino una allowlist: acá lo que no se puede deshacer es el destinatario.
//
// Por eso lleva su propio control, que es distinto y más restrictivo en lo que
// importa acá: una ALLOWLIST DE DESTINATARIOS. No alcanza con confirmar que el
// usuario quiere mandar el mensaje; hay que confirmar a QUIÉN. Ver `enviar`.
//
// Toda salida —texto, interactivo, documento y subida de archivo— pasa por
// `postMensaje`/`subirMedia`, y las dos chequean la allowlist ANTES de armar la
// request. Un método nuevo que no pase por ahí es un bug de seguridad, no un
// atajo: por eso `postMensaje` es privado y no hay forma de mandar un cuerpo
// arbitrario desde afuera.
//
// El guard estático (`check:readonly`) excluye este archivo por el mismo
// criterio con el que excluye `write/`: es una capa de salida declarada, con su
// propia barrera, no una fuga en la superficie de lectura.
// =============================================================================

import { createHash, randomUUID } from "node:crypto";
import type { KapsoConfig } from "../config.js";
import { logger } from "../logger.js";
import { BillerError, redactSecrets } from "../utils/errors.js";
import {
  clavesSalidaKapso,
  crearKapsoIdempotencyStore,
  KapsoIdempotencyError,
  KapsoPersistenciaRequeridaError,
  type KapsoIdempotencyStore,
  type KapsoOutgoingOperation,
} from "./idempotency.js";
import type { IdempotencyStore } from "../write/idempotency.js";
import { readTextBounded } from "../utils/boundedResponse.js";

export { KapsoIdempotencyError, KapsoPersistenciaRequeridaError } from "./idempotency.js";

/** Largo máximo de un mensaje de texto de WhatsApp. */
export const MAX_MENSAJE_CHARS = 4096;
const MAX_KAPSO_RESPONSE_BYTES = 1024 * 1024;

/**
 * Límites de los mensajes interactivos de WhatsApp.
 *
 * No son recomendaciones: pasarse de cualquiera de estos hace que Meta rechace
 * el mensaje entero con un 400 genérico. Se validan localmente para que el
 * error diga qué campo se pasó y por cuánto, en vez de "invalid parameter".
 */
export const LIMITES_INTERACTIVO = {
  /** Cuerpo del mensaje. */
  cuerpo: 1024,
  /** Encabezado de texto. */
  encabezado: 60,
  /** Pie. */
  pie: 60,
  /** Máximo de botones de respuesta rápida. */
  botones: 3,
  /** Título de un botón. */
  botonTitulo: 20,
  /** Id de un botón (viaja de vuelta en la respuesta del usuario). */
  botonId: 256,
  /** Texto del botón que abre una lista. */
  listaBoton: 20,
  /** Máximo de filas SUMANDO todas las secciones. */
  listaFilas: 10,
  /** Título de una fila. */
  filaTitulo: 24,
  /** Descripción de una fila. */
  filaDescripcion: 72,
  /** Id de una fila. */
  filaId: 200,
} as const;

/** Caption de un documento. */
export const MAX_CAPTION_CHARS = 1024;

/** Tope de WhatsApp para documentos. Un PDF de un CFE está tres órdenes por debajo. */
export const MAX_DOCUMENTO_BYTES = 100 * 1024 * 1024;

/** Timeout de las llamadas a Kapso. Más corto que el de Biller: es solo un POST. */
export const KAPSO_TIMEOUT_MS = 15_000;

/** Subir un archivo tarda más que mandar un texto: el timeout se separa. */
export const KAPSO_UPLOAD_TIMEOUT_MS = 60_000;

export class KapsoError extends BillerError {
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super("network", message);
    this.status = status;
  }
}

/** El destinatario no está en la allowlist. Nunca llega a salir a la red. */
export class KapsoDestinatarioBloqueadoError extends BillerError {
  constructor(destinatario: string, permitidos: number) {
    super(
      "validation",
      `El destinatario ${destinatario} no está en la allowlist de KAPSO_DESTINATARIOS_PERMITIDOS ` +
        `(${permitidos} número(s) habilitado(s)). El mensaje NO se envió. Este server manda datos ` +
        "fiscales por WhatsApp: solo puede hacerlo a números explícitamente autorizados. " +
        "Si el número es correcto, agregalo a esa variable de entorno.",
    );
  }
}

/** Un mensaje interactivo violaba un límite de WhatsApp. No sale a la red. */
export class KapsoMensajeInvalidoError extends BillerError {
  constructor(message: string) {
    super("validation", message);
  }
}

export interface EnvioResultado {
  message_id: string | null;
  destinatario: string;
  caracteres: number;
}

export interface EnvioDocumentoResultado {
  message_id: string | null;
  destinatario: string;
  media_id: string;
  filename: string;
  bytes: number;
}

// --- Interactivos -----------------------------------------------------------

export interface BotonRespuesta {
  id: string;
  titulo: string;
}

export interface FilaLista {
  id: string;
  titulo: string;
  descripcion?: string;
}

export interface SeccionLista {
  titulo?: string;
  filas: FilaLista[];
}

/** Hasta 3 botones. Para "sí/no" y confirmaciones. */
export interface InteractivoBotones {
  tipo: "botones";
  encabezado?: string;
  cuerpo: string;
  pie?: string;
  botones: BotonRespuesta[];
}

/** Hasta 10 filas. Para un menú de opciones. */
export interface InteractivoLista {
  tipo: "lista";
  encabezado?: string;
  cuerpo: string;
  pie?: string;
  /** Texto del botón que despliega la lista (ej. "Ver opciones"). */
  boton: string;
  secciones: SeccionLista[];
}

export type Interactivo = InteractivoBotones | InteractivoLista;

/**
 * Traduce la representación interna a la forma que espera la Cloud API.
 *
 * Valida antes de traducir, y **falla en vez de truncar** todo lo que sea
 * estructural (ids, cantidad de opciones). Truncar un id rompe el vínculo con
 * lo que representa —un `confirmation_token` cortado es un token inválido— y
 * truncar la cantidad de opciones hace desaparecer una en silencio.
 *
 * Los textos largos (cuerpo, descripción) sí se recortan con "…": ahí el
 * contenido se degrada, no se corrompe.
 */
export function construirPayloadInteractivo(i: Interactivo): Record<string, unknown> {
  const recortar = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, max - 1)}…`;

  const exigir = (valor: string, max: number, campo: string): string => {
    if (valor.trim() === "") {
      throw new KapsoMensajeInvalidoError(`El campo "${campo}" de un mensaje interactivo no puede ir vacío.`);
    }
    if (valor.length > max) {
      throw new KapsoMensajeInvalidoError(
        `El campo "${campo}" tiene ${valor.length} caracteres y WhatsApp admite hasta ${max}. ` +
          "No se recorta automáticamente porque este valor identifica una opción: recortarlo la rompe.",
      );
    }
    return valor;
  };

  const base: Record<string, unknown> = {
    body: { text: recortar(i.cuerpo, LIMITES_INTERACTIVO.cuerpo) },
  };
  if (i.encabezado !== undefined) {
    base["header"] = { type: "text", text: recortar(i.encabezado, LIMITES_INTERACTIVO.encabezado) };
  }
  if (i.pie !== undefined) {
    base["footer"] = { text: recortar(i.pie, LIMITES_INTERACTIVO.pie) };
  }

  if (i.tipo === "botones") {
    if (i.botones.length === 0 || i.botones.length > LIMITES_INTERACTIVO.botones) {
      throw new KapsoMensajeInvalidoError(
        `Un mensaje con botones admite entre 1 y ${LIMITES_INTERACTIVO.botones} botones; se pasaron ${i.botones.length}. ` +
          "Si hay más opciones, usá una lista (hasta 10 filas).",
      );
    }
    return {
      ...base,
      type: "button",
      action: {
        buttons: i.botones.map((b) => ({
          type: "reply",
          reply: {
            id: exigir(b.id, LIMITES_INTERACTIVO.botonId, "boton.id"),
            title: exigir(b.titulo, LIMITES_INTERACTIVO.botonTitulo, "boton.titulo"),
          },
        })),
      },
    };
  }

  const filas = i.secciones.flatMap((s) => s.filas);
  if (filas.length === 0 || filas.length > LIMITES_INTERACTIVO.listaFilas) {
    throw new KapsoMensajeInvalidoError(
      `Una lista interactiva admite entre 1 y ${LIMITES_INTERACTIVO.listaFilas} filas sumando todas las ` +
        `secciones; se pasaron ${filas.length}.`,
    );
  }
  const ids = new Set(filas.map((f) => f.id));
  if (ids.size !== filas.length) {
    throw new KapsoMensajeInvalidoError(
      "Hay filas con el mismo id en la lista interactiva. El id es lo que vuelve cuando el usuario " +
        "elige: repetido, no se puede saber qué eligió.",
    );
  }

  return {
    ...base,
    type: "list",
    action: {
      button: exigir(i.boton, LIMITES_INTERACTIVO.listaBoton, "boton"),
      sections: i.secciones.map((s) => ({
        ...(s.titulo !== undefined ? { title: recortar(s.titulo, LIMITES_INTERACTIVO.filaTitulo) } : {}),
        rows: s.filas.map((f) => ({
          id: exigir(f.id, LIMITES_INTERACTIVO.filaId, "fila.id"),
          title: exigir(f.titulo, LIMITES_INTERACTIVO.filaTitulo, "fila.titulo"),
          ...(f.descripcion !== undefined
            ? { description: recortar(f.descripcion, LIMITES_INTERACTIVO.filaDescripcion) }
            : {}),
        })),
      })),
    },
  };
}

export interface KapsoClientOptions {
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Inyectable para tests. Default: fetch global. */
  fetchImpl?: typeof fetch;
  /** Store propio de Kapso; nunca se comparte con el store fiscal. */
  idempotencyStore?: KapsoIdempotencyStore;
  /** Identidad opaca del actor que pidió la salida. Nunca se loguea en claro. */
  actorIdentity?: string;
  /** Reloj inyectable: la ventana de reserva y el día de la cobranza dependen de él. */
  ahora?: () => number;
}

export interface KapsoSendOptions {
  /** Identidad opaca del actor/remitente que originó la salida. */
  actorIdentity?: string;
  /** Clasificación explícita de la salida externa. */
  operation?: KapsoOutgoingOperation;
}

interface ReservaKapso {
  key: string;
  store: IdempotencyStore;
}

/**
 * El store de las salidas que no se reservan.
 *
 * No es un `if` repartido por los cuatro caminos de envío: los call sites
 * marcan `executed`/`ambiguous` igual que siempre y acá no pasa nada. Un
 * camino con menos ramas es un camino donde no se olvida marcar.
 */
const STORE_SIN_RESERVA: IdempotencyStore = {
  claim: () => true,
  markExecuted: () => {},
  markAmbiguous: () => {},
  release: () => {},
  has: () => false,
  markUsed: () => {},
  clear: () => {},
};

// Los handlers construyen un cliente por invocación, pero comparten el mismo
// objeto de configuración del tenant. Esta tabla conserva el store de memoria
// entre esos clientes sin convertirlo en singleton global entre tenants.
const storesPorConfig = new WeakMap<object, KapsoIdempotencyStore>();

export class KapsoClient {
  private readonly config: KapsoConfig;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly idempotency: KapsoIdempotencyStore;
  private readonly actorIdentity: string;
  private readonly ahora: () => number;

  constructor(config: KapsoConfig, options: KapsoClientOptions = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? KAPSO_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? KAPSO_UPLOAD_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.idempotency = options.idempotencyStore ?? this.storeParaConfig(config);
    this.actorIdentity = options.actorIdentity ?? "";
    this.ahora = options.ahora ?? (() => Date.now());
  }

  private storeParaConfig(config: KapsoConfig): KapsoIdempotencyStore {
    const existente = storesPorConfig.get(config as object);
    if (existente !== undefined) return existente;
    const nuevo = crearKapsoIdempotencyStore(config.idempotencyLogPath);
    storesPorConfig.set(config as object, nuevo);
    return nuevo;
  }

  private exigirPersistenciaCompatible(): void {
    // El archivo de la función serverless es efímero aunque tenga una ruta:
    // usarlo como si fuera durable reabre exactamente la ventana de duplicados
    // que este store está encargado de cerrar.
    if (this.config.serverless) throw new KapsoPersistenciaRequeridaError();
  }

  private reservar(
    destinatario: string,
    operation: KapsoOutgoingOperation,
    payload: unknown,
    options: KapsoSendOptions = {},
  ): ReservaKapso {
    this.exigirPersistenciaCompatible();
    const claves = clavesSalidaKapso(
      {
        tenantId: this.config.tenantId ?? "_proceso",
        actorIdentity: options.actorIdentity ?? this.actorIdentity,
        destinatario,
        operation,
        payload,
      },
      this.ahora(),
    );

    // Operación conversacional: no se reserva nada. Igual viaja una
    // `idempotency-key` ÚNICA —no una derivada del contenido— para que un
    // reintento nuestro de red no se duplique del lado de Kapso, y para que dos
    // menús legítimamente iguales no se coman entre ellos allá.
    if (claves === null) {
      return { key: `kapso:libre:${randomUUID()}`, store: STORE_SIN_RESERVA };
    }

    // El tramo anterior solo se consulta: un reintento que cruzó el borde de la
    // ventana no puede estrenar reserva y salir de nuevo.
    if (claves.previa !== undefined && this.idempotency.has(claves.previa)) {
      throw this.bloqueada(operation, destinatario, "tramo_anterior");
    }
    if (!this.idempotency.claim(claves.actual)) {
      throw this.bloqueada(operation, destinatario, "reserva_vigente");
    }
    return { key: claves.actual, store: this.idempotency };
  }

  /**
   * Un mensaje que NO salió por la reserva deja rastro.
   *
   * Sin esto, la única forma de enterarse de que la ventana está mal calibrada
   * —que es como se rompió esta protección la primera vez, bloqueando para
   * siempre— es que alguien reporte que el bot no le contestó. Se loguea el
   * hecho y la operación, nunca el contenido ni el número entero.
   */
  private bloqueada(
    operation: KapsoOutgoingOperation,
    destinatario: string,
    motivo: "reserva_vigente" | "tramo_anterior",
  ): KapsoIdempotencyError {
    logger.warn("kapso.salida.bloqueada_por_reserva", {
      operacion: operation,
      destinatario_sufijo: destinatario.slice(-4),
      motivo,
    });
    return new KapsoIdempotencyError();
  }

  /** true si `destinatario` (solo dígitos) está habilitado. */
  estaPermitido(destinatario: string): boolean {
    return this.config.destinatariosPermitidos.includes(destinatario);
  }

  /**
   * Puerta única de salida. Chequea allowlist y configuración ANTES de armar
   * nada: un destinatario no autorizado no debe generar ni siquiera una
   * conexión de salida que revele el intento.
   */
  private exigirDestinoValido(destinatario: string): string {
    if (!this.estaPermitido(destinatario)) {
      throw new KapsoDestinatarioBloqueadoError(
        destinatario,
        this.config.destinatariosPermitidos.length,
      );
    }
    return this.exigirPhoneNumberId();
  }

  private exigirPhoneNumberId(): string {
    if (this.config.phoneNumberId === undefined) {
      throw new KapsoError(
        "Falta KAPSO_PHONE_NUMBER_ID: es el ID del número de WhatsApp emisor, y va en la ruta del " +
          "endpoint de envío. Se obtiene en el panel de Kapso.",
      );
    }
    return this.config.phoneNumberId;
  }

  private url(recurso: "messages" | "media", phoneNumberId: string): string {
    return `${this.config.baseUrl}/meta/whatsapp/v24.0/${encodeURIComponent(phoneNumberId)}/${recurso}`;
  }

  /** Envuelve los errores de red/timeout con el vocabulario de Kapso. */
  private async ejecutar(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    accion: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: "error",
      });
      const { text: raw, truncated } = await readTextBounded(res, MAX_KAPSO_RESPONSE_BYTES);
      if (truncated) {
        throw new KapsoError(
          `Kapso devolvió más de ${MAX_KAPSO_RESPONSE_BYTES} bytes al ${accion}; se cortó la respuesta.`,
        );
      }
      if (!res.ok) {
        // El cuerpo de error de Kapso puede repetir headers: se redacta.
        const snippet = redactSecrets(raw.slice(0, 500), [this.config.apiKey]);
        throw new KapsoError(
          `Kapso respondió ${res.status} al ${accion}. Detalle: ${snippet}`,
          res.status,
        );
      }
      return raw;
    } catch (err) {
      if (err instanceof BillerError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new KapsoError(`La operación "${accion}" superó el timeout de ${timeoutMs} ms.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new KapsoError(`Error de red al contactar Kapso: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private static messageId(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ id?: string }> };
      return parsed.messages?.[0]?.id ?? null;
    } catch {
      // Respuesta 2xx no-JSON: el envío salió igual, solo no tenemos el id.
      return null;
    }
  }

  /**
   * POST al endpoint de mensajes. Privado a propósito: es el único camino de
   * salida y por eso es el único lugar donde vive el chequeo de allowlist.
   */
  private async postMensaje(
    destinatario: string,
    mensaje: Record<string, unknown>,
    meta: Record<string, unknown>,
    options: KapsoSendOptions = {},
    reserva?: ReservaKapso,
  ): Promise<string | null> {
    const phoneNumberId = this.exigirDestinoValido(destinatario);
    const propia =
      reserva ??
      this.reservar(
        destinatario,
        options.operation ?? (mensaje.type === "interactive" ? "interactivo" : "texto"),
        mensaje,
        options,
      );

    let raw: string;
    try {
      raw = await this.ejecutar(
        this.url("messages", phoneNumberId),
        {
          method: "POST", // check-readonly:allow POST a Kapso (WhatsApp), no a la API fiscal de Biller; capa de salida con allowlist
          headers: {
            "x-api-key": this.config.apiKey,
            "content-type": "application/json",
            "idempotency-key": propia.key,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: destinatario,
            ...mensaje,
          }),
        },
        this.timeoutMs,
        "enviar el mensaje",
      );
    } catch (err) {
      // Un timeout/corte no demuestra que Kapso no haya entregado el mensaje.
      // Se bloquea para siempre en vez de inducir un reintento duplicado.
      propia.store.markAmbiguous(propia.key);
      throw err;
    }

    const messageId = KapsoClient.messageId(raw);
    propia.store.markExecuted(propia.key);

    // Se loguea el HECHO del envío, no el contenido: el mensaje puede
    // incluir montos, RUTs y nombres de clientes.
    logger.info("kapso.mensaje.enviado", {
      destinatario_sufijo: destinatario.slice(-4),
      tipo: mensaje["type"],
      ...meta,
      message_id: messageId,
      idempotency_key: propia.key,
    });

    return messageId;
  }

  /** Envía un mensaje de texto por WhatsApp. */
  async enviar(
    destinatario: string,
    texto: string,
    options: KapsoSendOptions = {},
  ): Promise<EnvioResultado> {
    const cuerpo = texto.slice(0, MAX_MENSAJE_CHARS);
    const messageId = await this.postMensaje(
      destinatario,
      { type: "text", text: { body: cuerpo } },
      { caracteres: cuerpo.length },
      options,
    );
    return { message_id: messageId, destinatario, caracteres: cuerpo.length };
  }

  /**
   * Envía un mensaje interactivo (botones o lista).
   *
   * El payload se valida ANTES de la allowlist solo en lo que no toca la red:
   * `construirPayloadInteractivo` no hace I/O, así que un mensaje mal armado
   * falla igual sin destinatario válido. El orden real de salida lo sigue
   * fijando `postMensaje`.
   */
  async enviarInteractivo(
    destinatario: string,
    interactivo: Interactivo,
    options: KapsoSendOptions = {},
  ): Promise<EnvioResultado> {
    const payload = construirPayloadInteractivo(interactivo);
    const messageId = await this.postMensaje(
      destinatario,
      { type: "interactive", interactive: payload },
      { interactivo: interactivo.tipo, caracteres: interactivo.cuerpo.length },
      options,
    );
    return { message_id: messageId, destinatario, caracteres: interactivo.cuerpo.length };
  }

  /**
   * Sube un archivo y devuelve su `media_id`.
   *
   * Chequea la allowlist del destinatario ANTES de subir aunque la subida en sí
   * no lleve destinatario: subir el PDF de una factura a la infraestructura de
   * un tercero ya es sacar el dato del server. Si el envío posterior se va a
   * rechazar, no tiene sentido —ni es inocuo— haber subido el archivo.
   */
  async subirMedia(
    destinatario: string,
    archivo: { contenido: Uint8Array; filename: string; mimeType: string },
    options: KapsoSendOptions = {},
  ): Promise<{ media_id: string; bytes: number }> {
    const phoneNumberId = this.exigirDestinoValido(destinatario);

    return this.subirMediaConReserva(destinatario, phoneNumberId, archivo, options);
  }

  private async subirMediaConReserva(
    destinatario: string,
    phoneNumberId: string,
    archivo: { contenido: Uint8Array; filename: string; mimeType: string },
    options: KapsoSendOptions = {},
    reserva?: ReservaKapso,
  ): Promise<{ media_id: string; bytes: number }> {

    if (archivo.contenido.byteLength === 0) {
      throw new KapsoMensajeInvalidoError("El archivo a subir está vacío (0 bytes): no se envió nada.");
    }
    if (archivo.contenido.byteLength > MAX_DOCUMENTO_BYTES) {
      throw new KapsoMensajeInvalidoError(
        `El archivo pesa ${archivo.contenido.byteLength} bytes y WhatsApp admite hasta ${MAX_DOCUMENTO_BYTES} ` +
          "para documentos.",
      );
    }

    const payload = {
      sha256: createHash("sha256").update(archivo.contenido).digest("hex"),
      filename: archivo.filename,
      mimeType: archivo.mimeType,
      bytes: archivo.contenido.byteLength,
    };
    const propia = reserva ?? this.reservar(destinatario, options.operation ?? "media", payload, options);

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", archivo.mimeType);
    form.append("file", new Blob([archivo.contenido], { type: archivo.mimeType }), archivo.filename);

    let raw: string;
    try {
      raw = await this.ejecutar(
        this.url("media", phoneNumberId),
        {
          method: "POST", // check-readonly:allow POST a Kapso (subida de media), no a la API fiscal de Biller
          // Sin content-type explícito: fetch arma el boundary del multipart.
          headers: { "x-api-key": this.config.apiKey, "idempotency-key": propia.key },
          body: form,
        },
        this.uploadTimeoutMs,
        "subir el archivo",
      );
    } catch (err) {
      propia.store.markAmbiguous(propia.key);
      throw err;
    }

    let mediaId: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { id?: string };
      mediaId = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : null;
    } catch {
      mediaId = null;
    }
    if (mediaId === null) {
      propia.store.markAmbiguous(propia.key);
      throw new KapsoError(
        "Kapso aceptó la subida pero no devolvió un 'id' de media. Sin ese id no se puede adjuntar " +
          "el archivo a un mensaje.",
      );
    }

    logger.info("kapso.media.subida", {
      bytes: archivo.contenido.byteLength,
      mime: archivo.mimeType,
      media_id: mediaId,
      idempotency_key: propia.key,
    });

    propia.store.markExecuted(propia.key);

    return { media_id: mediaId, bytes: archivo.contenido.byteLength };
  }

  /**
   * Sube un archivo y lo manda como documento. Dos llamadas, una operación:
   * el `media_id` no tiene ningún uso fuera de esto.
   */
  async enviarDocumento(
    destinatario: string,
    archivo: { contenido: Uint8Array; filename: string; mimeType: string; caption?: string },
    options: KapsoSendOptions = {},
  ): Promise<EnvioDocumentoResultado> {
    const phoneNumberId = this.exigirDestinoValido(destinatario);
    if (archivo.contenido.byteLength === 0) {
      throw new KapsoMensajeInvalidoError("El archivo a subir está vacío (0 bytes): no se envió nada.");
    }
    if (archivo.contenido.byteLength > MAX_DOCUMENTO_BYTES) {
      throw new KapsoMensajeInvalidoError(
        `El archivo pesa ${archivo.contenido.byteLength} bytes y WhatsApp admite hasta ${MAX_DOCUMENTO_BYTES} ` +
          "para documentos.",
      );
    }
    const caption = archivo.caption?.slice(0, MAX_CAPTION_CHARS);
    const reserva = this.reservar(
      destinatario,
      options.operation ?? "documento",
      {
        sha256: createHash("sha256").update(archivo.contenido).digest("hex"),
        filename: archivo.filename,
        mimeType: archivo.mimeType,
        bytes: archivo.contenido.byteLength,
        ...(caption === undefined ? {} : { caption }),
      },
      options,
    );

    try {
      const { media_id, bytes } = await this.subirMediaConReserva(
        destinatario,
        phoneNumberId,
        archivo,
        options,
        reserva,
      );

      const messageId = await this.postMensaje(
        destinatario,
        {
          type: "document",
          document: {
            id: media_id,
            filename: archivo.filename,
            ...(caption !== undefined ? { caption } : {}),
          },
        },
        { bytes, media_id },
        options,
        reserva,
      );
      reserva.store.markExecuted(reserva.key);

      return { message_id: messageId, destinatario, media_id, filename: archivo.filename, bytes };
    } catch (err) {
      reserva.store.markAmbiguous(reserva.key);
      throw err;
    }
  }
}
