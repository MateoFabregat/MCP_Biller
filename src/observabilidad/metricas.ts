// =============================================================================
// Métricas de uso: cómo sabemos que anda.
//
// LA PREGUNTA QUE ESTO CONTESTA
//
// Hay 900+ tests y ninguno prueba lo que la gente escribe de verdad, porque no
// se puede: los tests prueban lo que a nosotros se nos ocurrió que escribiría.
// La prueba de que eso no alcanza es concreta —una auditoría a mano encontró
// que SIETE DE SIETE frases reales caían en "no entendí", con la suite entera en
// verde—. Sin números de producción, el producto solo mejora por auditorías:
// caras, puntuales, y encuentran nada más que lo que se les ocurre buscar.
//
// Las tres preguntas que hay que poder contestar el lunes:
//   · ¿qué proporción de mensajes cae en `desconocido`?
//   · ¿cuántas emisiones se abandonan a mitad de flujo, y en qué paso?
//   · ¿cuántas veces el resolvedor contesta "ambiguo"?
//
// ---------------------------------------------------------------------------
// LA REGLA QUE DEFINE EL MÓDULO: ACÁ NO ENTRA UN DATO FISCAL. NUNCA.
//
// Ni un importe, ni un RUT, ni un nombre de cliente, ni un teléfono, ni el
// texto de un mensaje. Y no alcanza con prometerlo en un comentario: las
// métricas van a un canal (stderr, un agregador de logs, una tool de consulta)
// que NO pasa por la barrera de salida ni por la de entrada. Un dato que se
// filtre por acá se filtra sin que ninguna de las dos lo vea.
//
// Por eso la protección es estructural, no una convención:
//   1. los NOMBRES de métrica son una unión cerrada de TypeScript;
//   2. los VALORES de etiqueta se validan contra un patrón estrecho
//      (`[a-z0-9_.:-]`, 32 caracteres) y todo lo demás se reemplaza por
//      "invalido" — un RUT, un monto con coma, un nombre con espacios o
//      cualquier texto de usuario no pasa ese filtro;
//   3. hay un TECHO DE CARDINALIDAD por métrica. Si alguien alguna vez etiqueta
//      con algo variable, el contador se corta en seco y queda un contador
//      `_desbordado` visible, en vez de crecer sin límite guardando datos.
//
// El punto 2 es el que importa: hace que pasar un dato de un cliente sea
// IMPOSIBLE por construcción, no "algo que no hacemos".
//
// ---------------------------------------------------------------------------
// DOS SALIDAS, PORQUE HAY TRES RUNTIMES
//
// El proceso HTTP vive horas y los contadores en memoria sirven. En Vercel cada
// request puede caer en una instancia distinta y morir enseguida: ahí la memoria
// no sirve para nada. Por eso cada evento hace las dos cosas:
//
//   · suma a un contador en memoria  -> lo lee `biller_metricas` (tiempo real)
//   · emite UNA línea a stderr       -> lo junta el agregador de logs (serverless)
//
// Es el mismo criterio que ya usa `write/audit.ts`, y por el mismo motivo.
//
// UN REGISTRO POR TENANT. El registro se crea en `createToolContext`, que ya es
// por empresa. Si fuera global, la tool de métricas de una empresa mostraría
// cuánto usa el sistema la otra — que es información comercial de un tercero.
// =============================================================================

import { logger } from "../logger.js";

/**
 * Los nombres posibles. Unión cerrada a propósito: agregar una métrica es
 * editar este tipo, y ahí es donde se piensa si el dato que se quiere contar
 * es contable sin identificar a nadie.
 */
export type NombreMetrica =
  /** Una tool se invocó. Etiquetas: tool, resultado. */
  | "tool.invocacion"
  /** Cuánto tardó una tool. Etiquetas: tool, bucket. */
  | "tool.duracion"
  /** Llegó un mensaje al enrutador de WhatsApp. Etiqueta: via. LA MÁS IMPORTANTE. */
  | "enrutador.mensaje"
  /** El resolvedor buscó un nombre. Etiquetas: tipo, clase. */
  | "resolver.consulta"
  /** La emisión guiada pidió un paso. Etiqueta: paso. Es el embudo. */
  | "emision.paso"
  /** Cómo terminó una emisión: emitida, rechazada o solo preview. Cierra el embudo. */
  | "emision.desenlace"
  /**
   * Ventanas de comprobantes servidas de memoria vs. pedidas a la API.
   * Etiqueta: resultado (hit|miss).
   *
   * Es POR EMPRESA como todo lo demás en este registro, y acá el motivo tiene
   * filo propio: un contador global de proceso le mostraría a una empresa
   * cuánto consulta la otra. Con el cache compartido entre tenants la
   * tentación de un singleton es real —el cache SÍ es uno solo—, pero lo que
   * se cuenta no es el cache: es el uso de una empresa.
   */
  | "cache.ventana";

// NO EXISTEN, Y ES A PROPÓSITO: `whatsapp.envio` y `webhook.evento`.
//
// Estaban declaradas acá y no las emitía nadie — o sea, una promesa en un tipo.
// Al ir a implementarlas apareció el motivo real de cada ausencia:
//
//   · `whatsapp.envio` necesitaría cuatro puntos de emisión (menú, comprobante,
//     recordatorio, paso de emisión) para contestar algo que el log de Kapso ya
//     contesta mejor. Cuatro ediciones para duplicar un dato que ya existe.
//
//   · `webhook.evento` NO SE PUEDE contar bien acá. El webhook entra ANTES de
//     resolver el tenant —esa es su naturaleza: llega de Meta, no de un cliente
//     autenticado— y este registro es por empresa. Contarlo exigiría un registro
//     global, que es justo lo que el encabezado prohíbe: la métrica de una
//     empresa no puede mezclarse con la de otra. Si algún día hace falta, el
//     lugar correcto es el log de acceso HTTP, no este módulo.

/** Etiquetas de una muestra. Valores de un vocabulario chico y cerrado. */
export type Etiquetas = Record<string, string | number | undefined>;

/**
 * Qué forma puede tener un valor de etiqueta.
 *
 * Estrecho a propósito: sin espacios, sin acentos y SIN PUNTO. Un nombre
 * ("ACME SA"), un importe ("14.640,00") y cualquier frase de un usuario fallan
 * este patrón y se reemplazan por "invalido".
 *
 * El punto se sacó del set después de que un test lo encontrara: con él,
 * "21.000.000.0011" —un RUT tal cual se escribe— pasaba entero. Ninguna
 * etiqueta legítima lo necesita (`hasta_200ms`, `desconocido`, `ok`,
 * `biller_cuenta_corriente`), así que sacarlo no cuesta nada y cierra la puerta.
 *
 * EL LARGO ES 48 Y NO 32 POR UN BUG QUE ESTE FILTRO SE COMÍA SOLO.
 *
 * Con 32, cuatro nombres de tool no entraban —el más largo,
 * `biller_listar_comprobantes_recibidos`, tiene 36— y se contaban TODOS como
 * `tool=invalido`, fusionados en un mismo balde. O sea que la métrica de
 * invocaciones mentía justo sobre las tools más usadas, en silencio.
 *
 * Subir el largo no afloja nada: lo que protege son las otras dos reglas. Un
 * nombre de cliente tiene espacios, un importe tiene coma, y un identificador
 * tiene la corrida de dígitos de abajo. El largo nunca fue la defensa.
 */
const VALOR_VALIDO = /^[a-z0-9_:-]{1,48}$/;

/**
 * Corridas largas de dígitos: RUT, CI, teléfono, número de comprobante.
 *
 * El patrón de arriba no las agarra —son alfanuméricas— y son EXACTAMENTE los
 * identificadores que no pueden salir por acá. Ocho dígitos es el piso: por
 * debajo están los valores legítimos (un conteo, un año, un bucket), y por
 * encima no hay ninguna etiqueta honesta que necesite ese largo.
 *
 * Esto salió de un test que probó un RUT y pasó. La lección vale más que el
 * parche: "el filtro rechaza texto libre" NO era lo mismo que "el filtro rechaza
 * datos de un cliente", y yo las había tratado como la misma cosa.
 */
const CORRIDA_DE_DIGITOS = /\d{8,}/;

/** Techo de combinaciones distintas por métrica. Ver el encabezado. */
export const MAX_CARDINALIDAD = 200;

/** Etiqueta con la que se reemplaza un valor que no pasa el filtro. */
export const VALOR_INVALIDO = "invalido";

/** Buckets de duración, en ms. Un CFE lento y una consulta rápida no se mezclan. */
export const BUCKETS_MS = [50, 200, 1000, 3000, 10_000] as const;

/** A qué bucket cae una duración. Determinístico y sin decimales. */
export function bucketDe(ms: number): string {
  for (const techo of BUCKETS_MS) {
    if (ms <= techo) return `hasta_${techo}ms`;
  }
  return `mas_de_${BUCKETS_MS[BUCKETS_MS.length - 1]}ms`;
}

/**
 * Normaliza un valor de etiqueta. Todo lo que no entre en el vocabulario chico
 * sale como "invalido" — visible, contable, y sin el dato adentro.
 */
export function normalizarValor(valor: string | number | undefined): string | null {
  if (valor === undefined) return null;

  // Los números pasan por el MISMO filtro que los strings, no por uno propio.
  // Un RUT o un teléfono llegando como `number` es la forma más fácil de
  // esquivar una validación pensada para texto.
  const crudo = typeof valor === "number" ? (Number.isFinite(valor) ? String(Math.trunc(valor)) : "") : valor;

  const limpio = crudo.trim().toLowerCase();
  if (limpio === "") return VALOR_INVALIDO;
  if (!VALOR_VALIDO.test(limpio)) return VALOR_INVALIDO;
  if (CORRIDA_DE_DIGITOS.test(limpio)) return VALOR_INVALIDO;
  return limpio;
}

/** Clave estable de una combinación de etiquetas. Ordenada: no depende del orden de escritura. */
function claveDe(nombre: NombreMetrica, etiquetas: Etiquetas): string {
  const partes = Object.keys(etiquetas)
    .sort()
    .map((k) => {
      const v = normalizarValor(etiquetas[k]);
      return v === null ? null : `${k}=${v}`;
    })
    .filter((p): p is string => p !== null);
  return partes.length === 0 ? nombre : `${nombre}{${partes.join(",")}}`;
}

export interface MuestraMetrica {
  nombre: NombreMetrica;
  etiquetas: Record<string, string>;
  valor: number;
}

export interface InstantaneaMetricas {
  desde: string;
  muestras: MuestraMetrica[];
  /** Métricas que tocaron el techo de cardinalidad. Vacío es lo normal. */
  desbordadas: string[];
  total_eventos: number;
}

export interface Metricas {
  /**
   * Suma `veces` (default 1) a un contador.
   *
   * El parámetro existe por un caso concreto: una consulta de un año son 54
   * ventanas, y contarlas de a una emitía 54 líneas de log idénticas para
   * responder una sola pregunta. El contador tiene que quedar igual; lo que no
   * tiene que multiplicarse por 54 es el ruido.
   */
  contar(nombre: NombreMetrica, etiquetas?: Etiquetas, veces?: number): void;
  /** Registra una duración en su bucket. No guarda el valor exacto. */
  observarDuracion(nombre: NombreMetrica, ms: number, etiquetas?: Etiquetas): void;
  instantanea(): InstantaneaMetricas;
  reiniciar(): void;
}

/**
 * Registro en memoria + una línea de log por evento.
 *
 * El log no es redundante con el contador: es la única salida que sobrevive en
 * serverless, donde el proceso se muere entre invocaciones.
 */
export class RegistroMetricas implements Metricas {
  private readonly contadores = new Map<string, MuestraMetrica>();
  private readonly desbordadas = new Set<string>();
  private readonly porNombre = new Map<NombreMetrica, Set<string>>();
  private desde: string;
  private total = 0;
  private readonly emitirLog: boolean;

  /**
   * Id de empresa para la LÍNEA DE LOG. `undefined` en mono-tenant.
   *
   * No entra en los contadores en memoria: esos ya son uno por empresa (viven en
   * el contexto), así que ahí sería una etiqueta constante que solo gasta
   * cardinalidad. En el log sí hace falta, porque el log es la única salida que
   * se mezcla entre empresas — y sin esto, con veinte tenants, el agregador no
   * puede contestar de quién es el embudo de emisión que se cayó.
   *
   * Pasa por `normalizarValor` como cualquier otra etiqueta: el id de tenant es
   * `[a-z0-9_-]` y no es secreto, pero la garantía del módulo es estructural, no
   * "confiamos en el llamador".
   */
  private readonly tenantId: string | undefined;

  /** `emitirLog=false` en los tests: no ensucia la salida ni prueba el logger. */
  constructor(opciones: { emitirLog?: boolean; ahora?: () => Date; tenantId?: string } = {}) {
    this.emitirLog = opciones.emitirLog ?? true;
    this.tenantId = opciones.tenantId === undefined ? undefined : (normalizarValor(opciones.tenantId) ?? undefined);
    this.ahora = opciones.ahora ?? (() => new Date());
    this.desde = this.ahora().toISOString();
  }

  private readonly ahora: () => Date;

  contar(nombre: NombreMetrica, etiquetas: Etiquetas = {}, veces = 1): void {
    // Un `veces` no entero, negativo o NaN no suma nada: un contador con basura
    // adentro es peor que un contador que no se movió.
    const cantidad = Number.isFinite(veces) ? Math.trunc(veces) : 0;
    if (cantidad <= 0) return;

    const clave = claveDe(nombre, etiquetas);
    const existente = this.contadores.get(clave);

    if (existente === undefined) {
      // Techo de cardinalidad: se corta ANTES de guardar la combinación nueva,
      // así una etiqueta variable no puede llenar la memoria con datos.
      const vistas = this.porNombre.get(nombre) ?? new Set<string>();
      if (vistas.size >= MAX_CARDINALIDAD) {
        this.desbordadas.add(nombre);
        // El evento SÍ ocurrió: lo que no se puede es guardar una combinación
        // nueva de etiquetas. Salir sin sumarlo al total dejaba a
        // `no_entendidos_pct` dividiendo por un denominador incompleto — o sea
        // que el desborde no solo perdía detalle, corrompía los porcentajes.
        this.total += cantidad;
        return;
      }
      vistas.add(clave);
      this.porNombre.set(nombre, vistas);

      const limpias: Record<string, string> = {};
      for (const [k, v] of Object.entries(etiquetas)) {
        const normalizado = normalizarValor(v);
        if (normalizado !== null) limpias[k] = normalizado;
      }
      this.contadores.set(clave, { nombre, etiquetas: limpias, valor: cantidad });
    } else {
      existente.valor += cantidad;
    }

    this.total += cantidad;

    if (this.emitirLog) {
      // Una línea por evento. Solo el nombre y las etiquetas YA normalizadas:
      // nunca el valor crudo que llegó.
      const muestra = this.contadores.get(clave);
      logger.info("metrica", {
        nombre,
        ...(this.tenantId !== undefined ? { empresa: this.tenantId } : {}),
        ...(muestra?.etiquetas ?? {}),
      });
    }
  }

  observarDuracion(nombre: NombreMetrica, ms: number, etiquetas: Etiquetas = {}): void {
    this.contar(nombre, { ...etiquetas, bucket: bucketDe(ms) });
  }

  instantanea(): InstantaneaMetricas {
    return {
      desde: this.desde,
      muestras: [...this.contadores.values()].sort(
        (a, b) => b.valor - a.valor || a.nombre.localeCompare(b.nombre),
      ),
      desbordadas: [...this.desbordadas],
      total_eventos: this.total,
    };
  }

  reiniciar(): void {
    this.contadores.clear();
    this.desbordadas.clear();
    this.porNombre.clear();
    this.total = 0;
    this.desde = this.ahora().toISOString();
  }
}

/**
 * Registro que no hace nada.
 *
 * Existe para que ningún llamador tenga que preguntarse si las métricas están
 * disponibles. Un `if (metricas !== undefined)` repetido en quince lugares es
 * la forma más segura de que en el dieciseisavo falte.
 */
export const METRICAS_NULAS: Metricas = {
  contar: () => {},
  observarDuracion: () => {},
  instantanea: () => ({ desde: "", muestras: [], desbordadas: [], total_eventos: 0 }),
  reiniciar: () => {},
};
