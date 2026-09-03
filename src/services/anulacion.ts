// =============================================================================
// Anulación y reversión de un CFE: qué hay que emitir para deshacer qué.
//
// LA CORRECCIÓN CONCEPTUAL QUE ORIGINÓ ESTE MÓDULO.
// El resto del proyecto venía diciendo que emitir es "irreversible ante DGI".
// Es falso, y la diferencia importa para el producto:
//
//   · Un CFE mal emitido se ANULA con una Nota de Crédito por el total. El
//     comprobante original sigue existiendo —la numeración ante DGI no se
//     recicla— pero queda sin efecto económico.
//   · Si esa anulación fue el error, se emite una Nota de DÉBITO contra la
//     Nota de Crédito, y el comprobante original vuelve a tener validez.
//
// O sea: no es irreversible, es CORREGIBLE, y cada corrección deja rastro. Eso
// cambia el tono correcto de las barreras de escritura: no son un "cuidado, esto
// no tiene vuelta atrás" (mentira que paraliza), sino un "esto emite un
// documento fiscal real; si sale mal, se arregla con otro documento, no con un
// undo". El costo de equivocarse es la cadena de correcciones, no la catástrofe.
//
// EL PATRÓN DE LOS TIPOS. La tabla de valores de Biller es regular: para cada
// familia, el tipo base termina en 1, su nota de crédito en 2 y su nota de
// débito en 3 (101/102/103, 111/112/113, 121/122/123, …). Esa regularidad es lo
// que hace que anular sea mecánico. Igual NO se calcula con aritmética sobre el
// número: se declara el mapa explícito, porque una familia futura que rompa el
// patrón produciría, en silencio, una nota de crédito de un tipo inexistente.
// =============================================================================

import { TIPOS_COMPROBANTE, TIPOS_EXPORTACION } from "../biller/cfeSchema.js";
import { TASA_IVA } from "./calcularTotales.js";
import { estaAceptado } from "./resumenFacturacion.js";

/** tipo original -> tipo de la Nota de Crédito que lo anula. */
export const NOTA_CREDITO_DE: Record<number, number> = {
  101: 102,
  111: 112,
  121: 122,
  131: 132,
  141: 142,
  151: 152,
};

/** tipo de Nota de Crédito -> tipo de la Nota de Débito que la revierte. */
export const NOTA_DEBITO_DE: Record<number, number> = {
  102: 103,
  112: 113,
  122: 123,
  132: 133,
  142: 143,
  152: 153,
};

/** Tipos que el endpoint POST /v2/comprobantes/anular sabe anular solo. */
const ANULABLES_POR_ENDPOINT = new Set([101, 111]);

export type AccionAnulacion =
  /** Emitir una NC que deja sin efecto el comprobante. */
  | "nota_credito"
  /** Emitir una ND que revierte una NC previa y devuelve validez al original. */
  | "nota_debito_reversion"
  /** El comprobante no se anula con una nota de ajuste. */
  | "no_aplica";

export interface ComprobanteAAnular {
  id: number | null;
  tipo_comprobante: number | null;
  serie: string | null;
  numero: number | null;
  moneda: string | null;
  total: number | null;
  fecha_emision: string | null;
  estado: string | null;
  /**
   * Desglose de IVA del original, tal como lo normaliza `normalizeComprobanteEmitido`.
   *
   * NO es decorativo: es lo único que dice a qué TASA hay que acreditar. Sin
   * esto la nota de crédito salía siempre a la básica (22%), y anular una
   * factura de tasa mínima sobreacreditaba IVA — plata que DGI no debe.
   * `undefined` o todo en null = el comprobante no trajo desglose.
   */
  iva?: { tasa_minima: number | null; tasa_basica: number | null; tasa_otra: number | null } | null;
  /**
   * Los ítems del original, si se consultó por `id` (el listado no los trae).
   *
   * Es la fuente MEJOR que el desglose de IVA: dice la tasa de cada línea en
   * vez de dejar que la reconstruyamos con aritmética. Cuando todas las líneas
   * comparten indicador —el caso normal—, la nota sale con ese indicador y una
   * sola línea por el total exacto, sin división ni redondeo de por medio.
   */
  items?: ReadonlyArray<{ indicador_facturacion?: number | null }> | null;
  /**
   * Cotización declarada por el original. Va al cuerpo cuando la moneda no es
   * el peso, y no es un detalle: `ComprobanteBodySchema` documenta que si se
   * omite, Biller toma **la cotización de cierre anterior a fecha_emision** —
   * o sea la de HOY, no la del comprobante que se está anulando. Una factura de
   * U$S 10.000 anulada con el dólar 3% arriba acredita ~1.600 pesos de IVA de
   * más, y no deja saldado el original en pesos.
   */
  tasa_cambio?: number | null;
  /** Retenciones/percepciones del original, solo para saber si las hay. */
  retenciones_percepciones?: unknown;
}

export interface PlanAnulacion {
  accion: AccionAnulacion;
  /** Tipo de CFE que hay que emitir. null si no aplica. */
  tipo_a_emitir: number | null;
  etiqueta_a_emitir: string | null;
  /** Qué efecto tiene, en castellano. */
  efecto: string;
  /**
   * true si se puede usar `biller_anular_comprobante` (POST /v2/comprobantes/anular),
   * que arma la NC solo. Solo aplica a e-Tickets y e-Facturas SIN comprobantes
   * asociados; si ya tiene una NC encima, hay que emitirla a mano.
   */
  usa_endpoint_anular: boolean;
  /** Cuerpo sugerido para `biller_emitir_comprobante`, si hay que emitir a mano. */
  cuerpo_sugerido: Record<string, unknown> | null;
  /** Pasos concretos, en orden. */
  pasos: string[];
  advertencias: string[];
}

/**
 * Arma el plan para dejar sin efecto un comprobante.
 *
 * @param yaTieneNotaCredito true si ya se le emitió una NC. Cambia el plan por
 *   completo: sobre un comprobante ya anulado, emitir OTRA nota de crédito lo
 *   acredita dos veces. Lo que corresponde ahí es una nota de débito, y solo si
 *   lo que se quiere es RESUCITAR el original.
 */
export function planAnulacion(
  c: ComprobanteAAnular,
  opciones: { ya_tiene_nota_credito?: boolean; razon?: string } = {},
): PlanAnulacion {
  const tipo = c.tipo_comprobante;
  const advertencias: string[] = [];

  if (tipo === null) {
    return {
      accion: "no_aplica",
      tipo_a_emitir: null,
      etiqueta_a_emitir: null,
      efecto: "No se puede planificar la anulación: el comprobante no trae tipo_comprobante.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: null,
      pasos: [],
      advertencias: ["Falta 'tipo_comprobante': sin eso no se sabe qué nota de ajuste corresponde."],
    };
  }

  const etiquetaOriginal = TIPOS_COMPROBANTE[tipo] ?? `tipo ${tipo}`;

  // --- Caso 2: lo que hay que deshacer es una NOTA DE CRÉDITO ---------------
  const tipoNd = NOTA_DEBITO_DE[tipo];
  if (tipoNd !== undefined) {
    const nota = cuerpoNota(tipoNd, c, opciones.razon ?? "Reversión de nota de crédito");
    return {
      accion: "nota_debito_reversion",
      tipo_a_emitir: tipoNd,
      etiqueta_a_emitir: TIPOS_COMPROBANTE[tipoNd] ?? null,
      efecto:
        `El comprobante ${c.serie ?? ""}-${c.numero ?? ""} ES una ${etiquetaOriginal}. ` +
        `Emitir una ${TIPOS_COMPROBANTE[tipoNd]} contra ella revierte la anulación: el comprobante ` +
        "original vuelve a tener validez económica.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: nota.cuerpo,
      pasos: [
        `Emitir un CFE tipo ${tipoNd} (${TIPOS_COMPROBANTE[tipoNd]}) por el mismo importe (${c.moneda ?? "?"} ${Math.abs(c.total ?? 0)}).`,
        `Referenciarlo a la nota de crédito ${c.serie ?? "?"}-${c.numero ?? "?"}${c.id !== null ? ` (id ${c.id})` : ""}.`,
        "Verificar después con biller_obtener_comprobante que quedó en estado \"Aceptado DGI\".",
      ],
      advertencias: [
        "Una nota de débito SUMA: si el objetivo no era resucitar el comprobante original sino " +
          "corregir un importe, revisá que el monto sea el correcto antes de emitir.",
        ...nota.advertencias,
      ],
    };
  }

  // --- Caso 1: anular un comprobante de venta ------------------------------
  const tipoNc = NOTA_CREDITO_DE[tipo];
  if (tipoNc === undefined) {
    return {
      accion: "no_aplica",
      tipo_a_emitir: null,
      etiqueta_a_emitir: null,
      efecto:
        `El tipo ${tipo} (${etiquetaOriginal}) no tiene una nota de crédito asociada en la tabla ` +
        "de valores: no se anula por esta vía.",
      usa_endpoint_anular: false,
      cuerpo_sugerido: null,
      pasos: [],
      advertencias: [
        tipo === 181 || tipo === 124
          ? "Los remitos no se anulan con nota de crédito: se corrigen con un remito de ajuste."
          : tipo === 182
            ? "Un e-Resguardo se anula con un ítem de indicador_facturacion 9 en otro e-Resguardo."
            : "Revisá en la documentación de DGI qué corresponde para este tipo.",
      ],
    };
  }

  const yaAnulado = opciones.ya_tiene_nota_credito === true;
  if (yaAnulado) {
    advertencias.push(
      "⚠️ Este comprobante YA tiene una nota de crédito asociada. Emitir otra lo acreditaría dos " +
        "veces y dejaría un saldo a favor del cliente que no corresponde. Si lo que querés es " +
        "revertir la anulación, hay que emitir una NOTA DE DÉBITO contra esa nota de crédito.",
    );
  }

  const puedeEndpoint = ANULABLES_POR_ENDPOINT.has(tipo) && !yaAnulado;
  // Solo se arma el cuerpo cuando hay que emitir a mano: si Biller lo arma solo
  // (`usa_endpoint_anular`), la tasa la decide él con el detalle real y derivarla
  // acá sería una segunda opinión sin dueño.
  const nota = puedeEndpoint
    ? { cuerpo: null, advertencias: [] as string[] }
    : cuerpoNota(tipoNc, c, opciones.razon ?? "Anulación de comprobante");

  return {
    accion: "nota_credito",
    tipo_a_emitir: tipoNc,
    etiqueta_a_emitir: TIPOS_COMPROBANTE[tipoNc] ?? null,
    efecto:
      `Emitir una ${TIPOS_COMPROBANTE[tipoNc]} por el total deja sin efecto ` +
      `${etiquetaOriginal} ${c.serie ?? ""}-${c.numero ?? ""}. El original NO desaparece: sigue ` +
      "existiendo ante DGI con su numeración, pero queda saldado. Si esto fuera un error, se " +
      `revierte después con una ${TIPOS_COMPROBANTE[NOTA_DEBITO_DE[tipoNc]!] ?? "nota de débito"}.`,
    usa_endpoint_anular: puedeEndpoint,
    cuerpo_sugerido: nota.cuerpo,
    pasos: puedeEndpoint
      ? [
          `Usar biller_anular_comprobante con id=${c.id ?? "(o tipo+serie+numero)"} y ` +
            "fecha_emision_hoy=true. Biller arma la nota de crédito por el total.",
          "Correr primero el dry-run (sin confirm) para leer el preview.",
          "Verificar después con biller_obtener_comprobante que la NC quedó \"Aceptado DGI\".",
        ]
      : nota.cuerpo === null
        ? [
            // SIN CUERPO LOS PASOS TIENEN QUE CAMBIAR. Decir "emitir un 112 por
            // el mismo importe" cuando no hay cuerpo sugerido hace que el modelo
            // lo arme él — y lo va a armar con indicador 3, que es exactamente
            // el bug que la falta de cuerpo está evitando.
            `Traer el detalle del comprobante ${c.serie ?? "?"}-${c.numero ?? "?"} con biller_obtener_comprobante: ` +
              "trae los items con su indicador_facturacion.",
            "Armar la nota copiando la tasa de cada línea del original. NO asumir 22%: mirá las advertencias.",
            `Referenciarla al comprobante ${c.serie ?? "?"}-${c.numero ?? "?"}${c.id !== null ? ` (id ${c.id})` : ""}.`,
            "Correr el dry-run y verificar que el total dé exactamente el del original.",
          ]
        : [
            `Emitir un CFE tipo ${tipoNc} (${TIPOS_COMPROBANTE[tipoNc]}) con biller_emitir_comprobante.`,
            `Referenciarlo al comprobante ${c.serie ?? "?"}-${c.numero ?? "?"}${c.id !== null ? ` (id ${c.id})` : ""}.`,
            `Por el mismo importe: ${c.moneda ?? "?"} ${c.total ?? "?"}.`,
            "Correr primero el dry-run para verificar el total calculado.",
          ],
    advertencias: [
      ...advertencias,
      ...nota.advertencias,
      ...(puedeEndpoint
        ? [
            "POST /v2/comprobantes/anular solo funciona si el comprobante NO tiene comprobantes " +
              "asociados. Si falla por eso, emití la nota de crédito a mano con el cuerpo sugerido.",
          ]
        : []),
      // `estaAceptado` es el dueño único del criterio "Aceptado DGI": el mismo
      // que hace que los totales coincidan con Biller. Reimplementarlo acá con
      // otro regex sería tener dos definiciones de lo mismo.
      ...(c.estado !== null && !estaAceptado(c.estado)
        ? [
            `El comprobante original está en estado "${c.estado}", no "Aceptado DGI". Un CFE que DGI ` +
              "no aceptó no tiene efecto fiscal: anularlo puede no ser lo que hace falta. Revisalo antes.",
          ]
        : []),
    ],
  };
}

/**
 * A QUÉ TASA SE ACREDITA: se deriva del original, no se asume.
 *
 * EL BUG QUE CIERRA. Hasta agosto de 2026 toda nota de crédito sugerida salía
 * con `indicador_facturacion: 3` (tasa básica, 22%) hardcodeado. Anular una
 * factura de tasa mínima —comida, medicamentos, el rubro de media PyME
 * uruguaya— acreditaba 22% de IVA sobre una venta que había pagado 10%: el
 * comprobante sale bien formado, DGI lo acepta, y la empresa se acredita IVA
 * que no pagó. Nadie se entera hasta una inspección.
 *
 * DE DÓNDE SALE LA TASA. El CFE trae el IVA ya discriminado por tasa
 * (`tot_iva_tasa_min`, `tot_iva_tasa_bas`, `tot_iva_tasa_otra`). Con el importe
 * de IVA y la tasa se reconstruye el bruto de cada porción:
 *
 *     bruto = iva + iva/tasa        (porque `montos_brutos: true`)
 *
 * y lo que sobra del total es la parte exenta. Es aritmética sobre campos que
 * la API ya devuelve, no una estimación.
 *
 * CUÁNDO NO SE ARMA EL CUERPO. Ante la duda no se adivina: si el comprobante
 * tiene IVA a "otra tasa" (no sabemos cuál es) o si el desglose no cierra
 * contra el total, se devuelve `null` y se dice por qué. Un cuerpo que parece
 * correcto y acredita mal es peor que no tener cuerpo: el primero se firma, el
 * segundo se revisa.
 */
const TASA_BASICA = 0.22;
const TASA_MINIMA = 0.1;

/** Indicadores de facturación de DGI que usa la nota. */
const IND_EXENTO = 1;
const IND_MINIMA = 2;
const IND_BASICA = 3;

/** Tolerancia al comparar plata: dos decimales, más el ruido de la división. */
const EPSILON = 0.02;

/** El peso, en las formas en las que la API lo devuelve. Ver `tipoCambio.ts`. */
function esMonedaBase(moneda: string | null): boolean {
  const m = (moneda ?? "").trim().toUpperCase();
  return m === "" || m === "UYU" || m === "858" || m === "UY";
}

function redondear2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Valor absoluto de un campo de IVA que puede venir null, string o negativo. */
function montoIva(v: number | null | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.abs(v);
}

export interface LineasNota {
  /** Líneas listas para el cuerpo, o null si no se pudo derivar sin adivinar. */
  items: Array<Record<string, unknown>> | null;
  advertencias: string[];
}

/**
 * Cuánto puede desviarse la reconstrucción antes de que sea un problema real.
 *
 * NO es un epsilon de centavos, y esa fue la primera versión equivocada.
 * Reconstruir el bruto divide por la tasa, así que el redondeo del IVA se
 * AMPLIFICA: dividir por 0,22 lo multiplica por 4,55. Y el IVA del CFE es la
 * suma de los IVA por línea YA redondeados, así que diez líneas con centavos
 * dan un desvío de decenas de centavos sobre una factura perfectamente sana.
 * Con un epsilon de 0,02 eso se reportaba como "el desglose no cierra" y
 * mandaba a auditar un comprobante correcto.
 */
function tolerancia(total: number): number {
  return Math.max(0.5, total * 0.005);
}

/** Indicadores cuya tasa conocemos. Uno que no esté acá NO se adivina. */
function tasaDe(indicador: number): number | null {
  const t = TASA_IVA[indicador];
  return typeof t === "number" ? t : null;
}

/**
 * Arma las líneas de la nota respetando las tasas del original.
 *
 * Exportada para poder testearla sin construir un plan entero.
 */
/**
 * La serie y el número del original, como texto seguro para un CFE.
 *
 * `serie` la normaliza `toStringOrNull`, o sea que es texto libre de la API, y
 * termina dentro de `concepto` — que viaja en `cuerpo_sugerido`, el único
 * subárbol EXENTO de las marcas de dato no confiable (está en
 * `SUBARBOLES_PROPIOS` porque es un ejemplo para copiar, y marcarlo imprimía
 * "⟦dato-no-confiable⟧" en el CFE). Esa exención vale mientras el cuerpo no
 * conserve texto libre de upstream: acá es donde se hace cierto.
 *
 * Una serie de DGI son letras y dígitos. Lo que no entra en eso no se
 * "escapa" ni se marca: se descarta, y queda el número, que es lo que
 * identifica al comprobante de todos modos.
 */
function identificacionOriginal(c: ComprobanteAAnular): string {
  const serie = (c.serie ?? "").trim();
  const seguro = /^[A-Za-z0-9]{1,10}$/.test(serie) ? serie : "";
  const numero = c.numero === null || c.numero === undefined ? "" : String(c.numero);
  if (seguro === "") return numero;
  return numero === "" ? seguro : `${seguro}-${numero}`;
}

export function lineasNota(c: ComprobanteAAnular, razon: string): LineasNota {
  const referencia = `${razon} ${identificacionOriginal(c)}`.trim();
  // Positivo: el signo lo da el TIPO de comprobante, no el importe. Una nota de
  // crédito con importe negativo se resta dos veces.
  const total = redondear2(Math.abs(c.total ?? 0));

  const linea = (concepto: string, precio: number, indicador: number): Record<string, unknown> => ({
    concepto,
    cantidad: 1,
    precio,
    indicador_facturacion: indicador,
  });

  // --- Sin total no hay nota ------------------------------------------------
  //
  // `Math.abs(null ?? 0)` daba 0 y el cuerpo salía con una línea en $0: un CFE
  // tipo 112 real, que consume numeración, parece haber anulado la factura y no
  // anula nada.
  if (!(total > 0)) {
    return {
      items: null,
      advertencias: [
        "El comprobante original no trae un total mayor a cero, así que no se puede armar la nota: " +
          "saldría por $0 y sería un documento fiscal que consume numeración sin anular nada. " +
          "Traé el comprobante con biller_obtener_comprobante y revisá su total.",
      ],
    };
  }

  const desglose = c.iva ?? null;
  const bas = montoIva(desglose?.tasa_basica);
  const min = montoIva(desglose?.tasa_minima);
  const otra = montoIva(desglose?.tasa_otra);
  const sinDesglose =
    desglose === null ||
    (desglose.tasa_basica === null && desglose.tasa_minima === null && desglose.tasa_otra === null);

  const advertencias: string[] = [];
  // No se ofrece un cuerpo incompleto: una retención que queda viva después de
  // "anular" el comprobante es un error fiscal silencioso. Sin contrato
  // documentado para invertir esta estructura variable, se deriva a revisión.
  if (c.retenciones_percepciones !== undefined && c.retenciones_percepciones !== null) {
    return {
      items: null,
      advertencias: [
        "El comprobante original tiene retenciones/percepciones. No se genera un cuerpo sugerido " +
          "porque copiarlo sin una regla documentada podría dejar la retención sin revertir o " +
          "duplicarla. Armá la nota con el detalle original y validala con tu contador.",
      ],
    };
  }

  // --- IVA a una tasa que no conocemos: se aborta ANTES de cualquier camino --
  //
  // Va arriba de todo a propósito. Estaba después del camino por ítems, así que
  // un comprobante con ítems e IVA a "otra tasa" salía igual, con indicador 4 y
  // sin la tasa que ese indicador necesita: el módulo declaraba por escrito que
  // no adivinaba, y adivinaba.
  if (otra > 0) {
    return {
      items: null,
      advertencias: [
        ...advertencias,
        `El comprobante tiene ${redondear2(otra)} de IVA a "otra tasa", y la tabla de valores no dice ` +
          "cuál es. Sin la tasa no se puede reconstruir el importe bruto de esa porción: la nota hay " +
          "que armarla a mano, copiando las líneas del original con biller_obtener_comprobante.",
      ],
    };
  }

  const ivaDeclarado = redondear2(bas + min);

  // --- Camino 1: los ítems del original dicen la tasa ------------------------
  //
  // Es el dato y no una reconstrucción, pero tiene TRES guardas, y las tres
  // salieron de casos que producían plata mal:
  //
  //  · un ítem SIN indicador no puede contar como unanimidad. Filtrar los null
  //    antes de contar los distintos los hacía invisibles: una factura con una
  //    línea al 22% y otra exenta sin indicador salía entera al 22%;
  //  · un indicador cuya tasa no conocemos (4, "otra tasa") no se usa;
  //  · si el IVA que implica esa tasa no coincide con el que declara el CFE,
  //    las dos fuentes se contradicen y no se elige una en silencio.
  const indicadoresCrudos = (c.items ?? []).map((i) => i?.indicador_facturacion);
  const indicadores = indicadoresCrudos.filter(
    (i): i is number => typeof i === "number" && Number.isFinite(i),
  );
  const unanimes =
    indicadoresCrudos.length > 0 &&
    indicadores.length === indicadoresCrudos.length &&
    new Set(indicadores).size === 1;

  if (unanimes) {
    const indicador = indicadores[0]!;
    const tasa = tasaDe(indicador);
    if (tasa === null) {
      return {
        items: null,
        advertencias: [
          ...advertencias,
          `Todas las líneas del original usan indicador_facturacion ${indicador}, cuya tasa no está ` +
            "en la tabla de valores. No se arma el cuerpo: la nota necesita una tasa conocida para " +
            "acreditar el importe correcto.",
        ],
      };
    }
    // El IVA que implica esa tasa sobre el total bruto.
    const ivaImplicito = redondear2(total - total / (1 + tasa));
    if (sinDesglose || Math.abs(ivaImplicito - ivaDeclarado) <= tolerancia(total)) {
      return { items: [linea(referencia, total, indicador)], advertencias };
    }
    advertencias.push(
      `Los ítems del original dicen indicador ${indicador} (IVA ${redondear2(ivaImplicito)}) pero su ` +
        `desglose declara ${ivaDeclarado}. Las dos fuentes se contradicen, así que la tasa se toma ` +
        "del desglose, que es el que DGI tiene registrado.",
    );
  }

  // --- Sin ítems utilizables y sin desglose: no se adivina -------------------
  if (sinDesglose) {
    return {
      items: null,
      advertencias: [
        ...advertencias,
        "El comprobante original no trae ni los ítems ni el desglose de IVA por tasa, así que NO se " +
          "puede saber a qué tasa hay que acreditar. No se arma el cuerpo: armarlo asumiendo la tasa " +
          "básica (22%) es lo que sobreacreditaba IVA cuando el original era de tasa mínima. Traé el " +
          "detalle con biller_obtener_comprobante y armá la nota con esas líneas.",
      ],
    };
  }

  // --- Camino 2: reconstruir el bruto de cada porción desde el desglose ------
  //
  // Vale porque el cuerpo va con `montos_brutos: true`: el precio de la línea
  // ES el importe con IVA adentro. `bruto = iva + iva/tasa` es exactamente el
  // inverso del `neto = linea/(1+tasa)` que hace `calcularTotales`.
  //
  // Exento: una exportación no es "exento" (indicador 1) sino indicador 10, y
  // mandarla como 1 empuja al modelo al tratamiento equivocado.
  const indExento = TIPOS_EXPORTACION.has(c.tipo_comprobante ?? -1) ? 10 : IND_EXENTO;

  if (bas === 0 && min === 0) {
    if (indExento === 10) {
      advertencias.push(
        "Es una nota sobre un comprobante de EXPORTACIÓN: además del indicador 10, el cuerpo " +
          "necesita modalidad_venta, clausula_venta, via_transporte y el ncm de cada ítem. No se " +
          "completan acá porque salen del original: traelo con biller_obtener_comprobante.",
      );
    }
    return { items: [linea(referencia, total, indExento)], advertencias };
  }

  const brutoBas = bas > 0 ? redondear2(bas + bas / TASA_BASICA) : 0;
  const brutoMin = min > 0 ? redondear2(min + min / TASA_MINIMA) : 0;
  const resto = redondear2(total - brutoBas - brutoMin);
  const tol = tolerancia(total);

  // --- El desglose no cierra por más de lo que explica el redondeo ----------
  if (resto < -tol) {
    return {
      items: null,
      advertencias: [
        ...advertencias,
        `El desglose de IVA del original no cierra contra su total: las porciones gravadas suman ` +
          `${redondear2(brutoBas + brutoMin)} y el total es ${total}. No se arma el cuerpo porque ` +
          "acreditaría más de lo facturado. Revisá el comprobante con biller_obtener_comprobante.",
      ],
    };
  }

  const items: Array<Record<string, unknown>> = [];
  const mixto = brutoBas > 0 && brutoMin > 0;
  // El residuo que el redondeo explica se ABSORBE en la línea gravada más
  // grande, en vez de descartarse. Descartarlo dejaba la nota uno o dos centavos
  // por debajo de la factura, que es lo contrario de "anula por el importe
  // exacto del original". Solo lo que supera la tolerancia es una porción exenta
  // de verdad.
  const esExento = resto > tol;
  const ajuste = esExento ? 0 : resto;
  const basFinal = redondear2(brutoBas + (brutoBas >= brutoMin ? ajuste : 0));
  const minFinal = redondear2(brutoMin + (brutoBas >= brutoMin ? 0 : ajuste));

  if (basFinal > 0) {
    items.push(linea(mixto ? `${referencia} (IVA básica)` : referencia, basFinal, IND_BASICA));
  }
  if (minFinal > 0) {
    items.push(linea(mixto ? `${referencia} (IVA mínima)` : referencia, minFinal, IND_MINIMA));
  }
  if (esExento) {
    items.push(linea(items.length > 0 ? `${referencia} (exento)` : referencia, resto, indExento));
  }

  if (mixto) {
    advertencias.push(
      "El comprobante original mezcla tasa básica y mínima, así que la nota va con una línea por " +
        "tasa. Verificá los importes en el preview antes de confirmar: si el original tenía " +
        "descuentos por línea, el reparto puede no coincidir peso a peso con el detalle original.",
    );
  }
  if (min > 0 && bas === 0) {
    advertencias.push(
      "El original es de TASA MÍNIMA (10%): la nota se arma con indicador_facturacion 2, no 3. Si " +
        "la emitís a mano, no la pases a básica.",
    );
  }

  return { items, advertencias };
}

/** Cuerpo listo para `biller_emitir_comprobante`, referenciando el original. */
function cuerpoNota(
  tipo: number,
  c: ComprobanteAAnular,
  razon: string,
): { cuerpo: Record<string, unknown> | null; advertencias: string[] } {
  const referencia =
    c.id !== null
      ? [c.id]
      : [{ tipo: c.tipo_comprobante, serie: c.serie, numero: c.numero }];

  const { items, advertencias } = lineasNota(c, razon);
  if (items === null) return { cuerpo: null, advertencias };

  return {
    cuerpo: {
      tipo_comprobante: tipo,
      moneda: c.moneda ?? "UYU",
      referencias: referencia,
      razon_referencia: razon,
      // CRÍTICO: `total` de un CFE ya viene con IVA incluido. Sin montos_brutos,
      // Biller interpreta el precio como neto y le SUMA el IVA otra vez: la nota
      // de crédito saldría por total × 1,22 y acreditaría de más. Este flag es lo
      // único que hace que la nota anule por el importe exacto del original.
      //
      // Y es lo que hace que `lineasNota` pueda reconstruir el bruto de cada
      // porción sumándole su IVA: las dos cosas son la misma decisión.
      montos_brutos: true,
      // La cotización del ORIGINAL, no la de hoy. Sin este campo Biller usa la
      // de cierre anterior a la fecha de emisión de la nota, y la nota acredita
      // en pesos un importe distinto al que registró la factura.
      ...(c.tasa_cambio !== null && c.tasa_cambio !== undefined && !esMonedaBase(c.moneda)
        ? { tasa_cambio: c.tasa_cambio }
        : {}),
      items,
      // El receptor de la nota tiene que ser el mismo del original; se completa
      // desde el comprobante consultado y no se inventa acá.
      cliente: "<mismo receptor que el comprobante original>",
    },
    advertencias,
  };
}
