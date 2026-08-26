// =============================================================================
// Cálculo LOCAL del total de un CFE antes de emitirlo.
//
// Para qué: el dry-run tiene que poder decir "esto va a salir $1.220 IVA
// incluido". Sin esto, confirmar una emisión es confirmar a ciegas — y por
// WhatsApp, donde el humano solo ve el mensaje de confirmación, es la única
// forma de que sepa qué está aprobando.
//
// ⚠️ Es una ESTIMACIÓN, no el cálculo fiscal de Biller. El total autoritativo es
// el que devuelve la API al emitir. Todo lo que no se puede determinar con
// certeza baja el flag `exacto` y se explica en `supuestos`/`advertencias`.
// =============================================================================

import type { ComprobanteBody } from "../biller/cfeSchema.js";
import { INDICADORES_FACTURACION } from "../biller/cfeSchema.js";
import { round2 } from "../biller/coerce.js";
import { formatearUy } from "./importe.js";

/**
 * Tasas de IVA por indicador de facturación (Uruguay: básica 22%, mínima 10%).
 * `null` = la tasa no se puede determinar desde el payload.
 */
const TASA_IVA: Record<number, number | null> = {
  1: 0, // Exento de IVA
  2: 0.1, // Tasa mínima
  3: 0.22, // Tasa básica
  4: null, // Otra tasa -> desconocida, no se puede calcular
  5: 0, // Entrega gratuita
  10: 0, // Exportación y asimiladas
  12: 0, // IVA en suspenso
  13: 0, // Ítem vendido no contribuyente
  14: 0, // Contribuyente monotributo
  15: 0, // Contribuyente IMEBA
  16: 0, // Contribuyente IVA mínimo / Monotributo / MIDES
};

/**
 * Indicadores cuyos ítems NO aportan al total monetario del comprobante
 * (entregas gratuitas, no facturables, ítems de ajuste de remito/resguardo).
 */
const NO_APORTAN_AL_TOTAL = new Set([5, 6, 7, 8, 9, 11]);

export interface LineaCalculada {
  concepto: string;
  cantidad: number;
  precio: number;
  indicador_facturacion: number | null;
  tratamiento: string;
  /** Importe de la línea después de descuentos/recargos del ítem. */
  neto: number;
  iva: number;
  total: number;
  aporta_al_total: boolean;
}

export interface TotalesEstimados {
  moneda: string | null;
  /** Suma de las líneas sin IVA. */
  subtotal: number;
  /** IVA discriminado por tasa (clave = porcentaje, ej. "22"). */
  iva_por_tasa: Record<string, number>;
  total_iva: number;
  /** Descuentos (negativo) y recargos (positivo) globales aplicados. */
  ajustes_globales: number;
  /**
   * Cada ajuste global por separado, con una etiqueta corta ya armada.
   *
   * Existe para que el preview pueda IMPRIMIR la fila ("Descuento 10% −$1.300")
   * en vez de dejar la diferencia escondida entre las líneas y el total. Sin
   * esto, `formatearTotales` solo tenía el número agregado y no podía decir de
   * qué era: un descuento invisible es plata que el usuario aprueba sin verla.
   */
  detalle_ajustes_globales: Array<{ etiqueta: string; monto: number }>;
  total: number;
  /** Suma de retenciones/percepciones (tasa/100 * monto_sujeto). Informativo. */
  total_retenciones_percepciones: number;
  lineas: LineaCalculada[];
  /**
   * false si algún ítem usa una tasa que no se puede determinar. Cuando es
   * false, el total es un piso, no el número final.
   */
  exacto: boolean;
  /** Interpretaciones que tomó el cálculo (la doc no las define del todo). */
  supuestos: string[];
  advertencias: string[];
}

/** Aplica un descuento/recargo "$" (importe sobre la línea) o "%" (porcentaje). */
function aplicarAjuste(base: number, tipo: "$" | "%" | undefined, cantidad: number | undefined, signo: 1 | -1): number {
  if (tipo === undefined || cantidad === undefined) return 0;
  const valor = tipo === "%" ? (base * cantidad) / 100 : cantidad;
  return signo * valor;
}

/**
 * Calcula los totales estimados de un CFE a partir de su cuerpo.
 *
 * Semántica de `montos_brutos` (documentada):
 *   - true/1  -> los precios de los ítems YA incluyen IVA: se desagrega hacia atrás.
 *   - false/0 -> el IVA se calcula y SE SUMA al total.
 */
export function calcularTotales(body: ComprobanteBody): TotalesEstimados {
  const supuestos: string[] = [];
  const advertencias: string[] = [];
  const lineas: LineaCalculada[] = [];
  const ivaPorTasa: Record<string, number> = {};

  const montosBrutos = body.montos_brutos === true;
  const items = body.items ?? [];
  let exacto = true;

  // Neto acumulado por indicador, para poder repartir los descuentos globales.
  const netoPorIndicador = new Map<number, number>();

  for (const item of items) {
    const cantidad = typeof item.cantidad === "number" ? item.cantidad : 0;
    const precio = typeof item.precio === "number" ? item.precio : 0;
    const indicador = typeof item.indicador_facturacion === "number" ? item.indicador_facturacion : null;

    let linea = cantidad * precio;
    linea += aplicarAjuste(linea, item.descuento_tipo, item.descuento_cantidad, -1);
    linea += aplicarAjuste(linea, item.recargo_tipo, item.recargo_cantidad, 1);

    const aporta = indicador === null || !NO_APORTAN_AL_TOTAL.has(indicador);
    const tasa = indicador === null ? null : TASA_IVA[indicador] ?? null;

    if (indicador !== null && tasa === null && aporta) {
      exacto = false;
      advertencias.push(
        `El ítem "${item.concepto}" usa indicador_facturacion ${indicador} ` +
          `(${INDICADORES_FACTURACION[indicador] ?? "desconocido"}): la tasa de IVA no se puede ` +
          "determinar desde el payload, así que no se sumó IVA por esa línea.",
      );
    }
    if (indicador === null) {
      exacto = false;
    }

    let neto: number;
    let iva: number;
    const tasaEfectiva = tasa ?? 0;
    if (montosBrutos) {
      // El precio incluye IVA: se desagrega.
      neto = tasaEfectiva > 0 ? linea / (1 + tasaEfectiva) : linea;
      iva = linea - neto;
    } else {
      neto = linea;
      iva = neto * tasaEfectiva;
    }

    if (aporta) {
      if (indicador !== null) {
        netoPorIndicador.set(indicador, (netoPorIndicador.get(indicador) ?? 0) + neto);
      }
      if (iva > 0) {
        const clave = String(round2(tasaEfectiva * 100));
        ivaPorTasa[clave] = round2((ivaPorTasa[clave] ?? 0) + iva);
      }
    }

    lineas.push({
      concepto: typeof item.concepto === "string" ? item.concepto : "(sin concepto)",
      cantidad,
      precio,
      indicador_facturacion: indicador,
      tratamiento:
        indicador === null
          ? "sin indicador_facturacion"
          : INDICADORES_FACTURACION[indicador] ?? `indicador ${indicador}`,
      neto: round2(neto),
      iva: round2(iva),
      total: round2(neto + iva),
      aporta_al_total: aporta,
    });
  }

  const noAportan = lineas.filter((l) => !l.aporta_al_total);
  if (noAportan.length > 0) {
    supuestos.push(
      `${noAportan.length} ítem(s) con indicador de entrega gratuita / no facturable no se sumaron al total.`,
    );
  }

  let subtotal = lineas.filter((l) => l.aporta_al_total).reduce((acc, l) => acc + l.neto, 0);
  let totalIva = Object.values(ivaPorTasa).reduce((acc, v) => acc + v, 0);

  // --- Descuentos y recargos globales -------------------------------------
  // Se aplican sobre el neto de los ítems que comparten indicador_facturacion.
  let ajustesGlobales = 0;
  const detalleAjustes: Array<{ etiqueta: string; monto: number }> = [];
  for (const dr of body.descuentosRecargos ?? []) {
    const base = netoPorIndicador.get(dr.indicador_facturacion) ?? 0;
    if (base === 0) {
      advertencias.push(
        `El descuento/recargo global "${dr.glosa ?? ""}" (indicador ${dr.indicador_facturacion}) ` +
          "no tiene ítems que le correspondan: no se aplicó al cálculo.",
      );
      continue;
    }
    const signo: 1 | -1 = dr.es_recargo ? 1 : -1;
    const monto = aplicarAjuste(base, dr.desc_rec_tipo, dr.valor, signo);
    ajustesGlobales += monto;
    // La etiqueta se arma ACÁ, donde el tipo y el valor todavía existen: para
    // cuando el preview lee `ajustes_globales`, el "10%" ya se perdió.
    detalleAjustes.push({
      etiqueta:
        (dr.es_recargo ? "Recargo" : "Descuento") +
        (dr.desc_rec_tipo === "%" && dr.valor !== undefined ? ` ${dr.valor}%` : ""),
      monto: round2(monto),
    });

    // El ajuste arrastra su parte proporcional de IVA.
    const tasa = TASA_IVA[dr.indicador_facturacion] ?? 0;
    if (tasa > 0) {
      const ivaAjuste = monto * tasa;
      const clave = String(round2(tasa * 100));
      ivaPorTasa[clave] = round2((ivaPorTasa[clave] ?? 0) + ivaAjuste);
      totalIva += ivaAjuste;
    }
  }
  subtotal += ajustesGlobales;

  if ((body.descuentosRecargos?.length ?? 0) > 0) {
    supuestos.push(
      'Los descuentos/recargos globales se aplicaron sobre el neto de los ítems con el mismo ' +
        "indicador_facturacion, que es como la doc los describe.",
    );
  }
  if (items.some((i) => i.descuento_tipo === "$" || i.recargo_tipo === "$")) {
    supuestos.push(
      'Los descuentos/recargos de ítem en "$" se interpretaron como importe sobre la LÍNEA ' +
        "(cantidad × precio), no por unidad.",
    );
  }

  // --- Retenciones / percepciones (informativo) ---------------------------
  // "El valor será calculado automáticamente como tasa / 100 * monto_sujeto."
  let totalRetenciones = 0;
  const todasLasRetenciones = [
    ...(body.retencionesPercepciones ?? []),
    ...items.flatMap((i) => i.retencionesPercepciones ?? []),
  ];
  for (const r of todasLasRetenciones) {
    totalRetenciones += (r.tasa / 100) * r.monto_sujeto;
  }
  if (todasLasRetenciones.length > 0) {
    supuestos.push(
      "Las retenciones/percepciones se informan aparte: no se suman al total del comprobante.",
    );
  }

  if (montosBrutos) {
    supuestos.push("montos_brutos activo: los precios ya incluían IVA y se desagregó hacia atrás.");
  }

  return {
    moneda: body.moneda ?? null,
    subtotal: round2(subtotal),
    iva_por_tasa: ivaPorTasa,
    total_iva: round2(totalIva),
    ajustes_globales: round2(ajustesGlobales),
    detalle_ajustes_globales: detalleAjustes,
    total: round2(subtotal + totalIva),
    total_retenciones_percepciones: round2(totalRetenciones),
    lineas,
    exacto,
    supuestos,
    advertencias,
  };
}

// =============================================================================
// El preview que lee el humano antes de emitir.
//
// LO QUE ESTABA MAL Y NO SE VEÍA
//
// La versión anterior devolvía UNA línea con los números crudos de JavaScript:
//
//     Total estimado: UYU 13000 (neto 10655.74 — IVA 22%: 2344.26)
//
// Tres problemas, y ninguno es cosmético:
//
//   1. `13000` y `10655.74` están escritos al revés de como se escriben en
//      Uruguay. `formatearUy` existe desde siempre para esto, y su propio
//      comentario dice por qué: "el eco de confirmación tiene que estar escrito
//      como el usuario escribe los números, o el usuario no puede verificar lo
//      que le estamos preguntando". El preview era justo el eco que no lo hacía.
//
//   2. No listaba los ítems. El único chequeo posible era "¿el total suena
//      bien?" — y el error típico no es el total, es la línea: dos bolsas en vez
//      de veinte, el precio del otro producto.
//
//   3. No mostraba NINGÚN supuesto. Ahora que la fecha, la forma de pago y la
//      cantidad se completan solas, eso dejó de ser una omisión y pasó a ser
//      inaceptable: un default que el usuario no ve no es un default, es una
//      suposición nuestra impresa en un documento fiscal.
//
// Los números los sigue calculando `calcularTotales` en TypeScript, y el
// `confirmation_token` sigue atado al payload por hash. Acá solo cambia cómo se
// escribe lo ya calculado.
// =============================================================================

/**
 * Los supuestos del comprobante, para poder declararlos.
 *
 * Son exactamente los campos que `aplicarDefaults` (kapso/emision.ts) completa
 * solo, más el criterio de IVA que sí se pregunta. Llegan por el cuerpo del CFE
 * y no por el `EstadoEmision` porque en el momento de emitir el estado ya no
 * existe: el payload es lo único que sobrevive al viaje por el modelo. Son los
 * mismos valores — el borrador los copia de ahí.
 */
export interface ContextoPreview {
  /** Fecha del comprobante, dd/mm/aaaa. */
  fecha_emision?: string;
  /** Código de FORMAS_PAGO: 1 contado, 2 crédito. */
  forma_pago?: number;
  /** Vencimiento dd/mm/aaaa, cuando es a crédito. */
  fecha_vencimiento?: string;
  /** true = los precios ya traían el IVA adentro. */
  montos_brutos?: boolean;
  /** Hoy en dd/mm/aaaa, para poder decir "Hoy 26/08/2026". Inyectable. */
  hoy?: string;
  /** Cuántas líneas de ítem se listan antes de resumir el resto. */
  max_lineas?: number;
  /**
   * Los precios que admitían MÁS DE UNA LECTURA, para rendirlos textualmente.
   *
   * "6.50" es 6,50 o 6.500 —cien veces de diferencia— y `parsearImporte` elige
   * el más probable MARCADO. Esa marca nace en el extractor, viaja por
   * `ItemEnCurso.precio_ambiguo` y muere acá, convertida en la única forma que
   * tiene de servir para algo: una línea escrita en el mensaje que el humano
   * lee antes de tocar "Emitir". Un preview de $13 sin una palabra no es una
   * confirmación, es una firma en blanco.
   */
  precios_ambiguos?: Array<{ concepto?: string; precio: number }>;
}

/** Cuántas líneas de ítem entran cómodas en los 1024 chars del cuerpo. */
const MAX_LINEAS_PREVIEW = 8;

/**
 * Techo del preview, con margen sobre los 1024 del cuerpo de WhatsApp.
 *
 * El margen no es prudencia: `construirConfirmacionEmision` mete este texto
 * ADENTRO de un mensaje que además lleva encabezado, documento del receptor y
 * el "¿Lo emito?" del final. Si el cuerpo se pasa, lo que se corta es el final
 * — o sea el TOTAL y los supuestos, justo lo que hay que leer.
 */
const MAX_CHARS_PREVIEW = 900;

/** Hasta dónde se recorta el concepto de una línea. */
const MAX_CONCEPTO_PREVIEW = 24;

/** "$" o "U$S". Mismo criterio que `simboloMoneda` de la emisión guiada. */
function simbolo(moneda: string | null): string {
  const m = (moneda ?? "UYU").toUpperCase();
  if (m === "USD") return "U$S";
  return m === "UYU" ? "$" : `${m} `;
}

/**
 * Alinea a la derecha una columna de importes.
 *
 * WhatsApp no usa tipografía monoespaciada, así que esto no queda perfecto — y
 * queda MUCHO mejor que no hacerlo: los importes terminan más o menos en la
 * misma zona y la línea se lee como una factura y no como una oración.
 */
function fila(etiqueta: string, importe: string, ancho: number): string {
  const espacio = Math.max(1, ancho - etiqueta.length - importe.length);
  return `${etiqueta}${" ".repeat(espacio)}${importe}`;
}

/**
 * La línea de supuestos: fecha · forma de pago · criterio de IVA.
 *
 * LA ARMA TYPESCRIPT, NUNCA EL MODELO. Es la contrapartida de haber sacado
 * cinco preguntas del flujo: lo que dejó de preguntarse tiene que aparecer acá,
 * y si lo redactara el modelo podría describir un comprobante distinto del que
 * se va a emitir sin que nadie lo note.
 */
export function describirSupuestos(ctx: ContextoPreview): string {
  const partes: string[] = [];

  if (ctx.fecha_emision !== undefined && ctx.fecha_emision !== "") {
    // "Hoy" adelante cuando coincide: es la forma más rápida de que alguien
    // detecte que el comprobante se está emitiendo con la fecha equivocada.
    partes.push(ctx.fecha_emision === ctx.hoy ? `Hoy ${ctx.fecha_emision}` : ctx.fecha_emision);
  }

  if (ctx.forma_pago === 1) partes.push("Contado");
  else if (ctx.forma_pago === 2) {
    partes.push(
      ctx.fecha_vencimiento === undefined || ctx.fecha_vencimiento === ""
        ? "Crédito"
        : `Crédito, vence ${ctx.fecha_vencimiento}`,
    );
  }

  // EL SILENCIO YA ES UNA RESPUESTA, Y ES LA QUE MÁS PLATA MUEVE.
  //
  // Los tres estados de `montos_brutos` se rinden, incluido `undefined`. No
  // decir nada cuando el campo falta era justo el caso peligroso: la API
  // interpreta la ausencia como "los precios son netos" y le suma el 22%, o sea
  // que el comprobante SÍ tiene un criterio de IVA aunque el payload no lo
  // diga. Callarlo dejaba al usuario aprobando un total 22% más alto que el que
  // había dictado, sin una palabra en el preview que se lo dijera.
  if (ctx.montos_brutos === true) partes.push("precios con IVA incluido");
  else if (ctx.montos_brutos === false) partes.push("IVA sumado aparte");
  else partes.push("IVA sumado aparte (la API asume precios netos)");

  return partes.join(" · ");
}

/**
 * El preview completo: ítems, desglose de IVA, total y supuestos.
 *
 * Pensado para el cuerpo de un interactivo de WhatsApp (1024 chars), así que
 * recorta conceptos largos y resume las líneas de más en vez de arriesgarse a
 * que el mensaje se trunque justo donde está el total.
 */
export function formatearTotales(t: TotalesEstimados, ctx: ContextoPreview = {}): string {
  const sim = simbolo(t.moneda);
  const plata = (n: number): string => `${sim}${formatearUy(n)}`;
  // El signo va ADELANTE del símbolo, como se escribe: "−$1.300", no "$−1.300".
  const conSigno = (n: number): string => (n < 0 ? `−${plata(-n)}` : `+${plata(n)}`);

  const visibles = t.lineas.slice(0, ctx.max_lineas ?? MAX_LINEAS_PREVIEW);
  const ocultas = t.lineas.length - visibles.length;

  const lineasItems = visibles.map((l) => {
    const concepto =
      l.concepto.length > MAX_CONCEPTO_PREVIEW
        ? `${l.concepto.slice(0, MAX_CONCEPTO_PREVIEW - 1)}…`
        : l.concepto;
    const etiqueta = `${formatearUy(l.cantidad)} × ${concepto}`;
    // Una entrega gratuita muestra el precio tachado de la única forma honesta:
    // diciendo que no suma. Mostrar su importe sin aclararlo haría que el total
    // pareciera mal sumado.
    return { etiqueta, importe: l.aporta_al_total ? plata(l.total) : "sin cargo" };
  });

  // EL NETO QUE SE MUESTRA ES EL DE ANTES DEL AJUSTE GLOBAL.
  //
  // `t.subtotal` ya viene con el descuento aplicado, así que imprimirlo junto a
  // la fila del descuento lo contaría dos veces a la vista. Se muestra la suma
  // de las líneas, después el ajuste, y después el IVA: así las tres filas
  // explican el total en vez de competir con él.
  const netoDeLineas = round2(t.subtotal - t.ajustes_globales);

  const totales: Array<{ etiqueta: string; importe: string }> = [
    { etiqueta: "Neto", importe: plata(netoDeLineas) },
    // La fila que faltaba: un descuento global del 10% dejaba $1.300 invisibles
    // entre las líneas y el total, y el usuario aprobaba una diferencia que no
    // estaba escrita en ningún lado.
    ...t.detalle_ajustes_globales.map((a) => ({
      etiqueta: a.etiqueta,
      importe: conSigno(a.monto),
    })),
    ...Object.entries(t.iva_por_tasa).map(([tasa, monto]) => ({
      etiqueta: `IVA ${tasa}%`,
      importe: plata(monto),
    })),
    { etiqueta: `TOTAL${t.exacto ? "" : " (aprox.)"}`, importe: plata(t.total) },
  ];

  // Las retenciones NO se suman al total (así lo define la doc), y por eso van
  // DEBAJO del TOTAL y con la aclaración puesta: una fila arriba haría pensar
  // que el número de abajo ya las incluye.
  if (t.total_retenciones_percepciones !== 0) {
    totales.push({
      etiqueta: "Retenciones (aparte)",
      importe: plata(t.total_retenciones_percepciones),
    });
  }

  const ancho =
    Math.max(...[...lineasItems, ...totales].map((f) => f.etiqueta.length + f.importe.length)) + 3;

  const bloques: string[] = [];
  if (lineasItems.length > 0) {
    const cuerpo = lineasItems.map((f) => fila(f.etiqueta, f.importe, ancho));
    if (ocultas > 0) cuerpo.push(`… y ${ocultas} ítem${ocultas === 1 ? "" : "s"} más`);
    bloques.push(cuerpo.join("\n"), "———");
  }
  bloques.push(totales.map((f) => fila(f.etiqueta, f.importe, ancho)).join("\n"));

  // Los supuestos van separados por una línea en blanco: no son parte de la
  // suma, son la letra chica de lo que el sistema decidió por su cuenta.
  const supuestos = describirSupuestos(ctx);
  if (supuestos !== "") bloques.push("", supuestos);

  const base = bloques.join("\n");
  const avisos = advertenciasDelPreview(t, ctx, plata);
  return avisos.length === 0 ? base : agregarAvisos(base, avisos);
}

/**
 * Las advertencias que tienen que estar EN EL MENSAJE, por orden de riesgo.
 *
 * El orden es el que se respeta al truncar, y no es estético: primero lo que
 * cambia el número que el usuario está por aprobar (un precio con dos lecturas
 * posibles, una tasa que no se pudo determinar), después lo que explica el
 * número (líneas sin cargo), y al final lo demás.
 */
function advertenciasDelPreview(
  t: TotalesEstimados,
  ctx: ContextoPreview,
  plata: (n: number) => string,
): string[] {
  const avisos: string[] = [];

  // 1. Los precios ambiguos. Van primero porque son el único aviso donde el
  //    total mostrado puede estar mal por CIEN VECES.
  for (const p of ctx.precios_ambiguos ?? []) {
    const cual = p.concepto === undefined || p.concepto.trim() === "" ? "" : ` de "${p.concepto}"`;
    // NO SE INVENTA LA OTRA LECTURA. Acá llega el número ya parseado, no el
    // texto que escribió el usuario, así que "también podría ser X" sería una
    // cuenta nuestra sobre un dato que no tenemos. Lo que sí se puede afirmar —y
    // es lo que hay que decir— es que el número de arriba está en duda y que la
    // diferencia es de dos órdenes de magnitud.
    avisos.push(
      `⚠️ El precio${cual} se leyó ${plata(p.precio)} por unidad, y estaba escrito de una forma ` +
        "que admite otra lectura muy distinta. Confirmalo ANTES de emitir.",
    );
  }

  // 2. Lo que el cálculo no pudo determinar y lo que no suma al total.
  for (const a of t.advertencias) avisos.push(`⚠️ ${a}`);

  const sinCargo = t.lineas.filter((l) => !l.aporta_al_total).length;
  if (sinCargo > 0) {
    avisos.push(
      `ℹ️ ${sinCargo} ítem(s) van sin cargo (entrega gratuita / no facturable): no suman al total.`,
    );
  }

  if (t.total_retenciones_percepciones !== 0) {
    avisos.push("ℹ️ Las retenciones/percepciones se informan aparte: no están sumadas en el TOTAL.");
  }

  return avisos;
}

/**
 * Pega los avisos abajo del preview SIN pasarse del techo del cuerpo.
 *
 * Se truncan los avisos y nunca los números: si algo tiene que caerse del
 * mensaje, que sea la letra chica del final y no el TOTAL. Lo que se recorta se
 * declara con un conteo, porque un aviso que desaparece sin dejar rastro es
 * peor que no haberlo escrito.
 */
function agregarAvisos(base: string, avisos: string[]): string {
  const puestos: string[] = [];
  let largo = base.length + 1; // el salto de línea que separa el bloque
  for (let i = 0; i < avisos.length; i += 1) {
    const aviso = avisos[i]!;
    const restantes = avisos.length - i;
    // Se reserva lugar para la línea de "y N avisos más" antes de decidir.
    const cola = restantes > 1 ? `\n… y ${restantes - 1} aviso(s) más` : "";
    if (largo + aviso.length + 1 + cola.length > MAX_CHARS_PREVIEW) {
      if (restantes > 0) puestos.push(`… y ${restantes} aviso(s) más`);
      break;
    }
    puestos.push(aviso);
    largo += aviso.length + 1;
  }
  return puestos.length === 0 ? base : `${base}\n${puestos.join("\n")}`;
}
