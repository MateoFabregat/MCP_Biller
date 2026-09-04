// =============================================================================
// El store del borrador de emisión.
//
// EL PROBLEMA
//
// `emision.ts` dice, en su propio encabezado, que no mantiene estado: "el hilo
// de la conversación lo lleva el Agent Node, que para eso tiene el historial".
// Eso está bien como diseño del MÓDULO —la función `siguientePaso` es pura y
// reanudable desde cualquier punto— pero deja el flujo más caro del producto
// apoyado en lo menos confiable que tenemos: el contexto de un modelo.
//
// El contrato de hoy es "el agente manda TODO lo que sabe en cada llamada". Si
// se olvida de un campo, el flujo lo vuelve a preguntar y el usuario ve que le
// preguntan dos veces lo mismo. Si se olvida del concepto del ítem, no hay forma
// de notarlo: el borrador sale sin esa línea y el CFE se emite incompleto.
//
// Este módulo guarda el estado del lado del server, con una clave de sesión, y
// lo devuelve como BASE sobre la que se aplica lo que llegue nuevo. El modelo
// puede olvidarse; el estado no.
//
// ---------------------------------------------------------------------------
// TRES DECISIONES QUE VALE LA PENA DEFENDER
//
// 1. LA CLAVE DE SESIÓN NO ES EL NÚMERO DE TELÉFONO.
//
//    La sesión natural es la conversación de WhatsApp, o sea el número. Pero el
//    número es un dato personal de un tercero —el cliente de nuestro cliente— y
//    acá termina en un archivo en disco y en cada log de error que mencione la
//    clave. `claveSesion` lo convierte en un hash: la sesión sigue siendo
//    estable entre mensajes, que es lo único que necesitamos, y el número no
//    queda escrito en ningún lado. Mismo criterio que `BillerClient.cacheId`.
//
// 2. UN BORRADOR VIEJO NO SE REANUDA: SE DESCARTA.
//
//    Un borrador de hace tres días tiene la fecha de emisión de hace tres días y
//    los precios de hace tres días. Reanudarlo en silencio es emitir un
//    comprobante que el usuario cree que es de hoy. Vencido = no existe, y el
//    flujo arranca de cero, que es lo que el usuario espera cuando vuelve a
//    escribir "quiero facturar" una semana después.
//
// 3. LA PERSISTENCIA EN DISCO ES OPT-IN, AL REVÉS QUE LA DE IDEMPOTENCIA.
//
//    El store de idempotencia guarda solo la key y el timestamp, y dice
//    explícitamente que nunca el payload. Acá el payload ES el punto: el
//    concepto de lo que se vendió, el nombre del cliente, la adenda. Eso es
//    información comercial de la empresa y datos de sus clientes.
//
//    Por eso el default es memoria y el archivo hay que pedirlo
//    (BILLER_BORRADOR_STORE_PATH). En stdio y en el server HTTP largo la memoria
//    alcanza —el proceso vive más que la conversación—; el archivo existe para
//    quien corre varias instancias y acepta el costo de tener esos textos en
//    disco. No es una optimización que se prenda sin pensarlo.
// =============================================================================

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { logger } from "../logger.js";
import type { EstadoEmision, ItemEnCurso } from "./emision.js";

/**
 * Cuánto vive un borrador sin que lo toquen. 24 horas.
 *
 * Es la ventana de servicio de WhatsApp: pasado ese rato ya no se le puede
 * mandar un mensaje libre al usuario, así que una conversación más vieja que eso
 * no se está continuando, se está empezando de nuevo.
 */
export const TTL_BORRADOR_MS = 24 * 60 * 60 * 1000;

/**
 * Techo de sesiones vivas en memoria.
 *
 * No es defensa contra un ataque: es que un proceso largo con un bug de claves
 * (una sesión nueva por mensaje, por ejemplo) crecería sin límite guardando
 * texto de clientes. Al tocar el techo se descarta la sesión menos usada
 * recientemente, que es la que más chance tiene de estar abandonada.
 */
export const MAX_SESIONES = 500;

export interface BorradorGuardado {
  estado: EstadoEmision;
  /** ISO. Cuándo se tocó por última vez. Manda para el TTL. */
  actualizado: string;
  /**
   * Cuántas veces se guardó.
   *
   * Dejó de ser solo diagnóstico: es el número que `guardar` compara para
   * detectar que otra llamada escribió mientras esta pensaba. Ver
   * `guardar(…, { desdeRevision })`.
   */
  revision: number;
}

export interface BorradorStore {
  /**
   * La clave opaca de esta conversación, YA LIGADA A LA EMPRESA.
   *
   * Vive en el store y no como función suelta a propósito: la sal que la liga a
   * la empresa la tiene el store, y "acordate de pasar la sal" es la clase de
   * convención que alguien olvida en la próxima tool. Acepta tanto un
   * identificador crudo (un teléfono, escrito de cualquier forma) como un
   * `sesion.id` que ya devolvió una llamada anterior.
   */
  clave(bruto: string): string;
  /** El borrador vivo de esa sesión, o null si no hay o si venció. */
  leer(sesion: string): BorradorGuardado | null;
  /**
   * Guarda el estado.
   *
   * `desdeRevision` es la revisión que quien llama LEYÓ antes de armar
   * `estado`. Si en el medio hubo otra escritura, el store fusiona en vez de
   * pisar. Omitirlo conserva el comportamiento viejo (pisar), que es lo
   * correcto para quien no leyó nada antes.
   */
  guardar(sesion: string, estado: EstadoEmision, opciones?: { desdeRevision?: number }): BorradorGuardado;
  /** Se llama cuando el flujo termina (emitido o abandonado a propósito). */
  borrar(sesion: string): void;
  /** Cuántas sesiones vivas hay. Para `biller_metricas` y los tests. */
  vivas(): number;
}

/**
 * Convierte lo que identifique a la conversación (un número de WhatsApp, un id
 * de chat) en una clave opaca y estable.
 *
 * 24 hex son 96 bits: de sobra para que dos conversaciones no colisionen, y
 * demasiado poco para volver atrás hasta el número.
 *
 * LA SAL NO ES DECORACIÓN, Y ES LO QUE FALTABA.
 *
 * Sin ella esto era un sha256 pelado de un espacio de diez millones de
 * teléfonos uruguayos: cualquiera con el archivo de borradores en la mano —o
 * con un log que mencione una clave— recupera el número entero en segundos
 * armando la tabla. O sea que el hash cumplía la mitad de su promesa: no
 * escribía el número, pero tampoco lo protegía.
 *
 * Salada con un secreto que ya existe (se deriva del apiToken, igual que
 * `BillerClient.cacheId`), el archivo deja de ser reversible y —de yapa— dos
 * empresas distintas dejan de compartir clave para el mismo teléfono. Ver
 * `BorradorStoreMemoria.clave`.
 */
export function claveSesion(bruto: string, sal = ""): string {
  return createHash("sha256")
    .update(`${sal}\0${canonizarSesion(bruto)}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Lo que se hashea. Absorbe las diferencias de FORMATO del mismo identificador.
 *
 * El problema real: el mismo teléfono llega escrito de varias formas a lo largo
 * de una conversación —"099 123 456", "099123456", "+598 99 123 456"— y cada
 * forma daba un hash distinto. La consecuencia no era teórica: el borrador se
 * guardaba con una clave y `biller_emitir_comprobante` intentaba borrarlo con
 * otra, así que **el borrador de un comprobante ya emitido sobrevivía 24 h** y
 * la factura siguiente arrancaba con el cliente y los ítems de la anterior.
 *
 * LO QUE ESTO NO HACE, Y NO ES UN OLVIDO: no le agrega ni le saca el código de
 * país. "099123456" y "59899123456" siguen siendo sesiones distintas. `config.ts`
 * ya decidió —y lo dejó escrito— que tocarle los dígitos al número del usuario
 * es peor que avisarle, porque el 0 nacional uruguayo no es el mismo dígito que
 * un código de país y adivinar cuál es cuál falla en silencio.
 *
 * La salida de verdad a ese problema es no depender del formato: el server
 * devuelve `sesion.id` ya hasheado y el agente lo repite tal cual. Ver
 * `biller_emision_guiada`.
 */
export function canonizarSesion(bruto: string): string {
  const limpio = bruto.trim().toLowerCase();
  // Si es un identificador con forma de teléfono (dígitos y puntuación de
  // marcado, nada más), vale por sus dígitos. Cualquier otro id —un uuid de
  // chat, un slug— se respeta tal cual: ahí no hay formato que absorber.
  return /^[+()\s.-]*[\d][\d()\s.+-]*$/.test(limpio) ? limpio.replace(/\D/g, "") : limpio;
}

/** true si el string ya es una clave emitida por `claveSesion` (24 hex). */
export function esClaveSesion(bruto: string): boolean {
  return /^[0-9a-f]{24}$/.test(bruto.trim().toLowerCase());
}

/**
 * La clave para un identificador que puede ser crudo (un teléfono) o ya hasheado
 * (el `sesion.id` que devolvió una llamada anterior).
 *
 * Aceptar las dos formas es lo que cierra el agujero de formato: el agente que
 * repite el `id` opaco no puede errarle, y el que manda el teléfono en otro
 * formato igual cae en la misma sesión.
 *
 * NO SE LLAMA DIRECTO DESDE LAS TOOLS, y eso es a propósito: la `sal` es la
 * identidad de la empresa y la tiene el store, no el llamador. Las tools usan
 * `BorradorStore.clave`, que es esto con la sal ya puesta — "acordate de pasar
 * la sal" es la clase de convención que alguien olvida en la próxima tool, y
 * olvidarla acá es que dos empresas compartan borrador.
 */
export function resolverClaveSesion(bruto: string, sal = ""): string {
  return esClaveSesion(bruto) ? bruto.trim().toLowerCase() : claveSesion(bruto, sal);
}

/**
 * Aplica lo que llegó nuevo sobre lo que ya estaba.
 *
 * LA REGLA: `undefined` significa "no me dijeron nada de esto", NUNCA "borralo".
 * Es la diferencia entre un agente que se olvidó de mandar `forma_pago` y un
 * usuario que quiere cambiarla — y si se confunden, cada llamada incompleta
 * borraría la mitad del borrador, que es exactamente el problema que este
 * módulo vino a resolver.
 *
 * LOS ÍTEMS SE FUSIONAN POR POSICIÓN, Y ANTES NO.
 *
 * La primera versión los reemplazaba enteros, con el argumento de que el array
 * es una lista ordenada donde el último elemento significa algo especial. El
 * argumento era bueno y la conclusión estaba mal, por un motivo que solo se ve
 * mirando las dos mitades juntas: el CONCEPTO de cada ítem no vuelve nunca en
 * la respuesta —lo envuelve la barrera de salida, ver `borradorComprobante`—,
 * así que un agente que perdió contexto NO PUEDE reenviar el array completo.
 * No es que se olvide: no lo tiene.
 *
 * Con reemplazo, mandar `items: [{ concepto: "flete", precio: 500 }]` teniendo
 * dos ítems cargados borraba el primero, y el CFE salía con una línea menos.
 * Un comprobante al que le falta media venta está perfectamente bien formado:
 * nada falla, y el error se descubre cobrando.
 *
 * Ahora cada posición se completa campo por campo y lo que llega definido pisa;
 * lo que llega `undefined` deja lo guardado. Borrar un ítem sigue siendo
 * imposible por acá, y está bien: el flujo no tiene un paso "sacá ese ítem", y
 * para empezar de nuevo está `reiniciar`.
 */
export function fusionarEstado(base: EstadoEmision, encima: EstadoEmision): EstadoEmision {
  const salida: EstadoEmision = { ...base };
  for (const [clave, valor] of Object.entries(encima)) {
    if (valor === undefined) continue;
    (salida as Record<string, unknown>)[clave] = valor;
  }
  if (encima.items !== undefined && base.items !== undefined) {
    salida.items = fusionarItems(base.items, encima.items);
  }
  return salida;
}

/**
 * Fusiona los ítems por POSICIÓN. Ver el comentario de `fusionarEstado`.
 *
 * Si el array que llega es más corto que el guardado, los de más NO se
 * descartan: se conservan. Es la decisión asimétrica a propósito — una línea de
 * más la ve el usuario en el preview antes de confirmar; una línea de menos no
 * la ve nadie hasta que factura mal.
 */
export function fusionarItems(
  base: ReadonlyArray<ItemEnCurso>,
  encima: ReadonlyArray<ItemEnCurso>,
): ItemEnCurso[] {
  const largo = Math.max(base.length, encima.length);
  const salida: ItemEnCurso[] = [];
  for (let i = 0; i < largo; i += 1) {
    const previo = base[i] ?? {};
    const nuevo = encima[i];
    if (nuevo === undefined) {
      salida.push({ ...previo });
      continue;
    }
    const item: ItemEnCurso = { ...previo };
    for (const [clave, valor] of Object.entries(nuevo)) {
      if (valor === undefined) continue;
      (item as Record<string, unknown>)[clave] = valor;
    }
    // `precio_copiado` NO SOBREVIVE A UNA LÍNEA QUE CAMBIÓ.
    //
    // La marca dice una sola cosa: "este precio salió de un CFE que se emitió
    // de verdad, así que un 0 acá es una bonificación y no un hueco". Es lo que
    // hace que `itemIncompleto` no vuelva a preguntar el precio de una línea
    // bonificada al repetir la última venta.
    //
    // Pero la fusión es POSICIONAL, así que la marca de la línea 1 de la venta
    // copiada le queda puesta a lo que sea que ocupe la línea 1 ahora. Si esa
    // línea pasó a ser otra cosa, el 0 heredado deja de ser una bonificación
    // dicha por alguien y pasa a ser un precio que nadie puso — y el flujo lo
    // da por completo. Resultado: una línea a $0 en un CFE real, sin que nadie
    // la vea preguntar. Se emite de menos y en silencio, que es el peor modo de
    // falla de este archivo.
    //
    // Dos disparadores, y los dos significan "esta línea ya no es la copiada":
    //   · llegó un precio explícito -> el precio es del usuario, no copiado;
    //   · cambió el concepto        -> es otro producto en la misma posición.
    if (nuevo.precio !== undefined || (nuevo.concepto !== undefined && nuevo.concepto !== previo.concepto)) {
      delete item.precio_copiado;
      delete item.precio_no_positivo_confirmado;
    }
    salida.push(item);
  }
  return salida;
}

/** Lo normal: el proceso vive más que la conversación. */
export class BorradorStoreMemoria implements BorradorStore {
  protected readonly borradores = new Map<string, BorradorGuardado>();
  /**
   * Lápidas: sesión interna → revisión que tenía el borrador al momento de
   * borrarse (0 si nunca llegó a existir en memoria).
   *
   * EXISTE PARA DISTINGUIR "OTRA LLAMADA ESCRIBIÓ" DE "EL USUARIO DESCARTÓ ESTO".
   *
   * Caso real: la llamada A lee el borrador (revisión 1), se va a esperar la
   * API. El usuario cancela — `borrar` deja la sesión sin nada — y arranca de
   * nuevo con otro cliente, que vuelve a guardarse con revisión 2 (monotónica,
   * ver `guardar`). Cuando A por fin vuelve y guarda con `desdeRevision: 1`,
   * SIN esta lápida no hay forma de notar que hubo un borrado en el medio: la
   * revisión leída (1) ya no coincide con la actual (2) de cualquier forma, así
   * que el store la trataría como el caso de fusión concurrente de siempre —y
   * fusionaría los datos que el usuario acaba de cancelar sobre los nuevos.
   *
   * NO SE BORRA AL GUARDAR ENCIMA, Y ES A PROPÓSITO. Como la revisión es
   * monotónica y nunca vuelve para atrás, cualquier `desdeRevision` posterior al
   * borrado real siempre va a ser MAYOR que la lápida (la sigue la revisión que
   * dejó el guardado nuevo, que ya arrancó en `lapida + 1`). Es decir: la
   * comparación `lapida >= desdeRevision` solo puede dar verdadero para una
   * lectura hecha ANTES del borrado, sin importar cuántos guardados legítimos
   * pasaron después. Borrarla en el primer guardado posterior reabriría
   * exactamente el agujero que esto vino a cerrar (ver el test de la llamada
   * tardía en `tests/borradorStore.test.ts`).
   *
   * El costo es memoria: una entrada por sesión que alguna vez se borró, para
   * siempre. Se acota igual que `borradores`, ver `desalojar`.
   */
  protected readonly lapidas = new Map<string, number>();
  protected readonly ahora: () => Date;
  /** El secreto de la empresa con el que se sala la clave. "" = sin identidad. */
  private readonly sal: string;
  /**
   * El prefijo que separa a esta empresa de las demás DENTRO del archivo.
   *
   * Salar la clave ya hace que dos empresas con el mismo teléfono no coincidan,
   * pero no alcanza para el otro camino: un `sesion.id` ajeno pegado a mano en
   * la tool de otra empresa es 24 hex válidos, y sobre un archivo compartido
   * habría resuelto contra el borrador del vecino. Con el espacio de nombres
   * delante, esa clave se busca bajo OTRO prefijo y simplemente no existe.
   *
   * Vacío cuando no hay identidad (el default en memoria), donde no hay nada
   * que separar: ahí cada store ya es un Map propio.
   */
  private readonly espacio: string;

  constructor(opciones: { ahora?: () => Date; sal?: string } = {}) {
    this.ahora = opciones.ahora ?? (() => new Date());
    this.sal = opciones.sal ?? "";
    this.espacio =
      this.sal === ""
        ? ""
        : `${createHash("sha256").update(`espacio\0${this.sal}`).digest("hex").slice(0, 8)}.`;
  }

  clave(bruto: string): string {
    return resolverClaveSesion(bruto, this.sal);
  }

  /**
   * La clave REAL bajo la que se guarda. Ver `espacio`.
   *
   * OJO: cambiar la sal (o rotar el token de la empresa) cambia todas las
   * claves y los borradores en curso dejan de encontrarse. Es aceptable y está
   * decidido: el TTL es de 24 h, así que lo peor que pasa es que una
   * conversación arranque de cero — que es exactamente lo que hace hoy cuando
   * el borrador vence.
   */
  private interna(sesion: string): string {
    return `${this.espacio}${sesion}`;
  }

  leer(sesionCruda: string): BorradorGuardado | null {
    const sesion = this.interna(sesionCruda);
    const guardado = this.borradores.get(sesion);
    if (guardado === undefined) return null;

    const edad = this.ahora().getTime() - Date.parse(guardado.actualizado);
    if (!Number.isFinite(edad) || edad > TTL_BORRADOR_MS) {
      // Vencido es igual que inexistente. Ver la decisión 2 del encabezado.
      this.borradores.delete(sesion); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
      return null;
    }

    // Reinsertar mueve la clave al final del orden de iteración del Map, que es
    // lo que hace que el desalojo de abajo sea "la menos usada" y no "la más
    // vieja de creación": una conversación activa de hace dos horas no se tiene
    // que caer antes que una abandonada de hace veinte minutos.
    this.borradores.delete(sesion); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
    this.borradores.set(sesion, guardado);
    return guardado;
  }

  /**
   * LA CARRERA QUE ESTO CIERRA.
   *
   * Dos mensajes de WhatsApp seguidos son dos llamadas superpuestas a
   * `biller_emision_guiada`. Cada una lee el borrador, se va a esperar cinco
   * GET contra la API para resolver el cliente, y recién entonces guarda. La
   * segunda guardaba sobre la base que había leído ANTES de que la primera
   * escribiera: la respuesta más nueva del usuario desaparecía y el flujo le
   * volvía a preguntar lo mismo. En el orden inverso desaparecían los ítems ya
   * dictados.
   *
   * La ventana no es teórica: es todo lo que tarda la API, y un burst de dos
   * mensajes en WhatsApp es lo más común del mundo.
   *
   * Se resuelve releyendo AL GUARDAR y fusionando con lo que haya ahora:
   * gana el valor más nuevo campo por campo, y ningún campo que el otro haya
   * escrito se pierde por no estar en nuestra copia vieja.
   *
   * ESO SÍ: LA BASE DESCARTADA PIERDE, NO GANA EL ÚLTIMO. Si entre la lectura
   * de quien llama y este guardado el usuario BORRÓ el borrador (canceló, o
   * `reiniciar=true`), lo que leyó quien llama ya no describe nada vivo. Fusionar
   * igual resucitaría exactamente lo que el usuario descartó. Ver la lápida más
   * abajo, y el comentario de `lapidas` en la clase.
   */
  guardar(
    sesionCruda: string,
    estado: EstadoEmision,
    opciones: { desdeRevision?: number } = {},
  ): BorradorGuardado {
    const previo = this.leer(sesionCruda);
    const sesion = this.interna(sesionCruda);
    const desdeRevision = opciones.desdeRevision;
    const lapida = this.lapidas.get(sesion);

    // ESCRITURA TARDÍA SOBRE ALGO QUE EL USUARIO YA DESCARTÓ.
    //
    // `desdeRevision > 0` dice "quien llama leyó un borrador real antes de
    // armar `estado`". Si para cuando guarda no hay nada vivo (se borró todo)
    // O la lápida es igual o posterior a lo que leyó, esa lectura quedó vieja:
    // el borrado pasó DESPUÉS de que leyó y ANTES de que escribiera. No se
    // guarda —ni se fusiona, que sería resucitar lo descartado— y se devuelve
    // el estado actual tal cual está.
    if (desdeRevision !== undefined && desdeRevision > 0 &&
      (previo === null || (lapida !== undefined && lapida >= desdeRevision))) {
      logger.info("borrador.escritura_tardia_descartada", {
        desde_revision: desdeRevision,
        lapida: lapida ?? null,
        habia_borrador_vivo: previo !== null,
      });
      return previo ?? { estado: {}, actualizado: this.ahora().toISOString(), revision: lapida ?? 0 };
    }

    const hubo0tro =
      desdeRevision !== undefined &&
      previo !== null &&
      previo.revision !== desdeRevision;
    const efectivo = hubo0tro ? fusionarEstado(previo.estado, estado) : estado;
    if (hubo0tro) {
      logger.info("borrador.fusion_concurrente", {
        revision_leida: desdeRevision ?? null,
        revision_actual: previo?.revision ?? null,
      });
    }

    const guardado: BorradorGuardado = {
      estado: efectivo,
      actualizado: this.ahora().toISOString(),
      // Monotónica: sigue desde la lápida si la sesión venía de un borrado, no
      // desde 0. Sin esto, el primer guardado tras un `borrar` volvía a numerar
      // desde 1 y una lectura vieja con `desdeRevision: 1` coincidía por
      // casualidad con la revisión "nueva" — el mismo agujero que esto cierra.
      revision: (previo?.revision ?? lapida ?? 0) + 1,
    };
    this.borradores.delete(sesion); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
    this.borradores.set(sesion, guardado);
    this.desalojar();
    this.persistir(sesion, guardado);
    return guardado;
  }

  borrar(sesionCruda: string): void {
    const sesion = this.interna(sesionCruda);
    const previo = this.borradores.get(sesion);
    this.borradores.delete(sesion); // check-readonly:allow Map.delete, no es HTTP

    // LA LÁPIDA SE ESCRIBE SIEMPRE, ESTÉ O NO EN MEMORIA.
    //
    // Antes se salía temprano cuando el Map no tenía la sesión, y eso convertía
    // el desalojo por LRU en un agujero: pasadas las 500 sesiones vivas, el
    // borrador de una emisión YA CONFIRMADA se caía de memoria, `borrar` no
    // anotaba nada, y otra instancia —o el mismo proceso tras un reinicio—
    // volvía a leer del archivo el borrador de un comprobante que ya existe.
    // La factura siguiente arrancaba con el cliente y los ítems de la anterior:
    // exactamente lo que este store dice impedir.
    //
    // Anotar el borrado de algo que no estaba es inocuo: la lápida dice "esta
    // sesión terminó", que es verdad tanto si estaba en memoria como si no. Sin
    // revisión previa (nunca vivió en memoria) queda en 0: no hay forma de saber
    // qué leyó una escritura tardía, así que no se bloquea nada por esto solo —
    // la rama "no hay previo" de `guardar` ya cubre el caso sin ambigüedad.
    this.lapidas.set(sesion, previo?.revision ?? 0);
    this.desalojarLapidas();
    this.persistirBorrado(sesion, previo?.revision ?? 0);
  }

  vivas(): number {
    return this.borradores.size;
  }

  private desalojar(): void {
    while (this.borradores.size > MAX_SESIONES) {
      const masVieja = this.borradores.keys().next();
      if (masVieja.done === true) return;
      this.borradores.delete(masVieja.value); // check-readonly:allow Map.delete, no es HTTP
      logger.warn(
        "Se desalojó un borrador de emisión por llegar al techo de sesiones. Si esto pasa seguido, " +
          "la clave de sesión está cambiando cuando no debería.",
        { sesiones: this.borradores.size },
      );
    }
  }

  /**
   * El reloj, para la subclase.
   *
   * Existe porque el registro de BORRADO también lleva timestamp, y antes usaba
   * `new Date()` directo: el único punto del módulo que se salteaba el reloj
   * inyectado. En un test con reloj falso, ese registro quedaba fechado en el
   * presente real — y el seam que existe para poder testear el vencimiento
   * dejaba de valer justo para la operación que borra cosas.
   */
  protected marcaDeTiempo(): string {
    return this.ahora().toISOString();
  }

  /**
   * Techo de lápidas, igual que `desalojar` para los borradores vivos: sin
   * esto, un proceso largo que emite y cancela sin parar acumula una entrada
   * por sesión PARA SIEMPRE (la lápida, a propósito, no se borra al guardar
   * encima — ver el comentario de `lapidas`). Desalojar la más vieja es
   * seguro: en el peor caso, una escritura tardía extremadamente demorada deja
   * de detectarse como tal y cae en la fusión concurrente de siempre, que es
   * exactamente el comportamiento de antes de este cambio.
   */
  private desalojarLapidas(): void {
    while (this.lapidas.size > MAX_SESIONES) {
      const masVieja = this.lapidas.keys().next();
      if (masVieja.done === true) return;
      this.lapidas.delete(masVieja.value); // check-readonly:allow Map.delete, no es HTTP
    }
  }

  /** Descarta todo lo que hay en memoria. Solo lo usa la subclase de archivo. */
  protected vaciarMemoria(): void {
    this.borradores.clear();
    // Las lápidas también describen el archivo, no la memoria: si el archivo
    // se achicó o se borró, la fuente de verdad para "qué se descartó" cambió
    // por completo y una lápida vieja podría bloquear una escritura legítima
    // sobre un archivo nuevo que nunca vio ese borrado.
    this.lapidas.clear();
  }

  /** Gancho para la subclase que escribe a disco. En memoria no hace nada. */
  protected persistir(_sesion: string, _guardado: BorradorGuardado): void {}
  /**
   * Anota el borrado donde el estado sobreviva al proceso.
   *
   * `revision` es la que tenía el borrador al morir: la necesita la otra
   * instancia para saber si una escritura suya, leída ANTES del borrado, quedó
   * obsoleta. Ver `aplicarLineas`.
   */
  protected persistirBorrado(_sesion: string, _revision: number): void {}
}

/**
 * Persistente, en un archivo de líneas JSON.
 *
 * Mismo formato y mismas concesiones que `FileIdempotencyStore`: append-only, se
 * lee entero al arrancar, gana la última línea de cada sesión, y una línea
 * corrupta se saltea sola sin descartar el archivo. Un borrado también es una
 * línea (con `borrado: true`), porque en un archivo append-only no se puede
 * quitar nada — y un borrado que no se anota es un borrador que resucita al
 * reiniciar.
 *
 * Los errores de E/S no se propagan: degradar a memoria es peor que persistir,
 * pero mucho mejor que cortarle la facturación a la empresa porque no se pudo
 * escribir un archivo auxiliar.
 */
export class BorradorStoreArchivo extends BorradorStoreMemoria {
  private readonly path: string;
  private degradado = false;
  private cargando = false;
  /** Hasta qué byte del archivo ya se leyó. Ver `refrescar`. */
  private leidoHasta = 0;

  constructor(path: string, opciones: { ahora?: () => Date; sal?: string } = {}) {
    super(opciones);
    this.path = path;
    this.refrescar();
    logger.info("borradores.cargados", { sesiones: this.borradores.size });
  }

  /**
   * Lee lo que OTRA instancia haya escrito desde la última vez.
   *
   * Este store existe para el escenario multi-instancia — el único donde la
   * memoria no alcanza —, y la primera versión leía el archivo una sola vez, al
   * arrancar. O sea que fallaba exactamente en su caso de uso: la instancia B
   * seguía sirviendo un borrador que la A ya había emitido y borrado, y nunca
   * veía los mensajes que la A había ido guardando.
   *
   * Como el archivo es append-only, "ponerse al día" es leer del byte donde
   * quedamos hasta el final: barato cuando no pasó nada (dos stats de archivo)
   * y proporcional a lo nuevo cuando pasó. Si el archivo se achicó —alguien lo
   * rotó o lo borró a mano— se relee entero desde cero, descartando la memoria:
   * el archivo es la fuente de verdad, no al revés.
   *
   * Lo que esto NO resuelve, a propósito: dos instancias escribiendo la MISMA
   * sesión a la vez. Ahí gana la última línea, como en cualquier log. Para el
   * caso real —una conversación de WhatsApp entra por una instancia por vez—
   * eso es exactamente lo correcto.
   */
  private refrescar(): void {
    this.cargando = true;
    try {
      if (!existsSync(this.path)) {
        // Archivo borrado o rotado a nada: la memoria ya no describe a nadie.
        // El contrato dice "el archivo es la fuente de verdad", así que se
        // vacía — antes solo se reseteaba el offset y los borradores viejos
        // seguían sirviéndose desde memoria.
        if (this.leidoHasta > 0) this.vaciarMemoria();
        this.leidoHasta = 0;
        return;
      }
      const stat = statSync(this.path);
      if (stat.size < this.leidoHasta) {
        // El archivo se achicó: rotación o borrado manual. La memoria ya no
        // describe al archivo; se descarta y se relee todo.
        this.vaciarMemoria();
        this.leidoHasta = 0;
      }
      if (stat.size === this.leidoHasta) return;

      const fd = openSync(this.path, "r");
      try {
        const largo = stat.size - this.leidoHasta;
        const buffer = Buffer.alloc(largo);
        const leido = readSync(fd, buffer, 0, largo, this.leidoHasta);

        // Solo hasta el ÚLTIMO \n. Un stat puede caer en el medio del append de
        // otra instancia: la línea partida no parsea (eso ya se toleraba), pero
        // avanzar el offset hasta el final se COMÍA la mitad restante — la
        // próxima lectura arrancaba en medio del JSON y la descartaba también.
        // Si esa línea era un borrado, el borrador emitido resucitaba: exactamente
        // lo que este store existe para impedir. Lo que quede después del último
        // salto de línea se relee entero en el próximo refresco.
        const texto = buffer.toString("utf8", 0, leido);
        const ultimoSalto = texto.lastIndexOf("\n");
        if (ultimoSalto === -1) return;
        this.aplicarLineas(texto.slice(0, ultimoSalto + 1));
        this.leidoHasta += Buffer.byteLength(texto.slice(0, ultimoSalto + 1), "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.degradar("leer", err);
    } finally {
      this.cargando = false;
    }
  }

  private aplicarLineas(texto: string): void {
    for (const linea of texto.split("\n")) {
      if (linea.trim() === "") continue;
      try {
        const e = JSON.parse(linea) as {
          sesion?: unknown;
          estado?: unknown;
          actualizado?: unknown;
          revision?: unknown;
          borrado?: unknown;
        };
        if (typeof e.sesion !== "string") continue;
        if (e.borrado === true) {
          // LA LÁPIDA TAMBIÉN VIAJA ENTRE INSTANCIAS.
          //
          // Sin esto, la detección de escrituras tardías funcionaba solo dentro
          // del proceso que borró: otra instancia leía el archivo, veía que la
          // sesión no está, y no tenía forma de saber que había estado y se
          // canceló. Una llamada lenta de ESA instancia resucitaba el borrador
          // de una factura que el usuario ya había descartado.
          //
          // La revisión de la línea de borrado es la que tenía el borrador al
          // morir; si la línea no la trae (formato viejo), se conserva la que
          // haya en memoria.
          const revisionMuerta =
            typeof e.revision === "number"
              ? e.revision
              : (this.borradores.get(e.sesion)?.revision ?? 0);
          this.borradores.delete(e.sesion); // check-readonly:allow Map.delete, no es HTTP
          this.lapidas.set(e.sesion, Math.max(revisionMuerta, this.lapidas.get(e.sesion) ?? 0));
          continue;
        }
        if (typeof e.estado !== "object" || e.estado === null) continue;
        if (typeof e.actualizado !== "string") continue;
        this.borradores.set(e.sesion, {
          estado: e.estado as EstadoEmision,
          actualizado: e.actualizado,
          revision: typeof e.revision === "number" ? e.revision : 1,
        });
      } catch {
        // Escritura interrumpida: se ignora esa línea, no el archivo.
      }
    }
  }

  override leer(sesion: string): BorradorGuardado | null {
    this.refrescar();
    return super.leer(sesion);
  }

  override guardar(
    sesion: string,
    estado: EstadoEmision,
    opciones: { desdeRevision?: number } = {},
  ): BorradorGuardado {
    // Refrescar ANTES de guardar, por la revisión: si otra instancia guardó
    // tres veces, la nuestra tiene que ser la cuarta, no la segunda. Y también
    // por la fusión: la revisión que se compara tiene que ser la del ARCHIVO,
    // no la que quedó en memoria antes del refresco.
    this.refrescar();
    return super.guardar(sesion, estado, opciones);
  }

  override borrar(sesion: string): void {
    // El refresco previo hace que un borrado de una sesión guardada por OTRA
    // instancia también funcione: primero se trae del archivo, después se borra
    // — y el borrado queda anotado para que la otra instancia se entere igual.
    this.refrescar();
    super.borrar(sesion);
  }

  private degradar(operacion: string, err: unknown): void {
    if (this.degradado) return;
    this.degradado = true;
    logger.warn(
      `No se pudo ${operacion} el archivo de borradores: el estado de la emisión guiada pasa a ` +
        "vivir solo en memoria y NO sobrevive a un reinicio.",
      { path: this.path, err: err instanceof Error ? err.message : String(err) },
    );
  }

  private escribir(entrada: Record<string, unknown>): void {
    if (this.cargando) return;
    try {
      // 0700/0600: el borrador tiene el concepto de lo que se vende, el nombre
      // del cliente, el RUT y la adenda — información comercial de la empresa y
      // datos de sus clientes. En un host compartido no la puede leer otro usuario.
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(entrada)}\n`, { encoding: "utf8", mode: 0o600 });
      // Ponerse al día con lo que uno mismo escribió, para que `leidoHasta`
      // acompañe al archivo. Sin esto, la detección de rotación ("el archivo se
      // achicó") no distingue un archivo truncado de uno donde solo escribimos
      // nosotros. Releer la propia línea es idempotente: aplica lo que ya está.
      this.refrescar();
    } catch (err) {
      this.degradar("escribir", err);
    }
  }

  protected override persistir(sesion: string, guardado: BorradorGuardado): void {
    this.escribir({ sesion, ...guardado });
  }

  protected override persistirBorrado(sesion: string, revision: number): void {
    this.escribir({ sesion, borrado: true, revision, actualizado: this.marcaDeTiempo() });
  }
}

/**
 * Elige la implementación según haya o no ruta configurada. Default: memoria.
 *
 * `sal` es la identidad de la empresa (se deriva del token, ver
 * `createToolContext`). Es opcional porque hay dos llamadores que no la tienen
 * —los tests y el contexto sin config— y en los dos casos la ausencia es
 * correcta: sin identidad no hay dos empresas que separar. Donde SÍ importa es
 * con BILLER_BORRADOR_STORE_PATH y multi-tenant, que es el único escenario donde
 * dos empresas escriben el mismo archivo.
 */
export function crearBorradorStore(path: string | undefined, sal?: string): BorradorStore {
  const opciones = sal === undefined || sal === "" ? {} : { sal };
  return path === undefined || path.trim() === ""
    ? new BorradorStoreMemoria(opciones)
    : new BorradorStoreArchivo(path.trim(), opciones);
}
