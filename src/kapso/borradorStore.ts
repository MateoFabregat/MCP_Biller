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
  /** Cuántas veces se guardó. Solo para diagnóstico. */
  revision: number;
}

export interface BorradorStore {
  /** El borrador vivo de esa sesión, o null si no hay o si venció. */
  leer(sesion: string): BorradorGuardado | null;
  guardar(sesion: string, estado: EstadoEmision): BorradorGuardado;
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
 */
export function claveSesion(bruto: string): string {
  return createHash("sha256").update(canonizarSesion(bruto)).digest("hex").slice(0, 24);
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
 */
export function resolverClaveSesion(bruto: string): string {
  return esClaveSesion(bruto) ? bruto.trim().toLowerCase() : claveSesion(bruto);
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
    salida.push(item);
  }
  return salida;
}

/** Lo normal: el proceso vive más que la conversación. */
export class BorradorStoreMemoria implements BorradorStore {
  protected readonly borradores = new Map<string, BorradorGuardado>();
  protected readonly ahora: () => Date;

  constructor(opciones: { ahora?: () => Date } = {}) {
    this.ahora = opciones.ahora ?? (() => new Date());
  }

  leer(sesion: string): BorradorGuardado | null {
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

  guardar(sesion: string, estado: EstadoEmision): BorradorGuardado {
    const previo = this.leer(sesion);
    const guardado: BorradorGuardado = {
      estado,
      actualizado: this.ahora().toISOString(),
      revision: (previo?.revision ?? 0) + 1,
    };
    this.borradores.delete(sesion); // check-readonly:allow Map.delete de una sesión en memoria, no es HTTP
    this.borradores.set(sesion, guardado);
    this.desalojar();
    this.persistir(sesion, guardado);
    return guardado;
  }

  borrar(sesion: string): void {
    if (!this.borradores.delete(sesion)) return; // check-readonly:allow Map.delete, no es HTTP
    this.persistirBorrado(sesion);
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

  /** Descarta todo lo que hay en memoria. Solo lo usa la subclase de archivo. */
  protected vaciarMemoria(): void {
    this.borradores.clear();
  }

  /** Gancho para la subclase que escribe a disco. En memoria no hace nada. */
  protected persistir(_sesion: string, _guardado: BorradorGuardado): void {}
  protected persistirBorrado(_sesion: string): void {}
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

  constructor(path: string, opciones: { ahora?: () => Date } = {}) {
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
          this.borradores.delete(e.sesion); // check-readonly:allow Map.delete, no es HTTP
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

  override guardar(sesion: string, estado: EstadoEmision): BorradorGuardado {
    // Refrescar ANTES de guardar, por la revisión: si otra instancia guardó
    // tres veces, la nuestra tiene que ser la cuarta, no la segunda.
    this.refrescar();
    return super.guardar(sesion, estado);
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
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entrada)}\n`, "utf8");
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

  protected override persistirBorrado(sesion: string): void {
    this.escribir({ sesion, borrado: true, actualizado: this.marcaDeTiempo() });
  }
}

/** Elige la implementación según haya o no ruta configurada. Default: memoria. */
export function crearBorradorStore(path: string | undefined): BorradorStore {
  return path === undefined || path.trim() === ""
    ? new BorradorStoreMemoria()
    : new BorradorStoreArchivo(path.trim());
}
