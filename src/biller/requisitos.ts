// =============================================================================
// "¿Qué necesito para emitir esto?" — requisitos de un CFE, campo por campo.
//
// POR QUÉ EXISTE. `cfeSchema.ts` sabe VALIDAR: recibe un cuerpo completo y dice
// qué está mal. Eso sirve cuando alguien ya armó el JSON. No sirve para el caso
// real: alguien escribe por WhatsApp "hacele una factura a Carbonell por 5000" y
// hay que ir pidiéndole lo que falta, de a una cosa por vez, en castellano.
//
// Este módulo es la otra mitad: dado un tipo de comprobante y lo que se sabe
// hasta ahora, responde QUÉ FALTA y CUÁL ES LA PRÓXIMA PREGUNTA. La lista de
// requisitos sale de la misma "Tabla de valores" que usa el schema, así que las
// dos mitades no pueden divergir: si un campo es obligatorio para validar, acá
// aparece como obligatorio para pedir.
//
// LA REGLA DE LAS 5.000 UI. DGI exige identificar al receptor cuando el importe
// del comprobante supera cierto monto en Unidades Indexadas. Es la regla que más
// se olvida y la que más caro sale: un e-Ticket al mostrador por encima del
// umbral SIN receptor identificado es un comprobante mal emitido.
//
// El problema práctico es que la UI cambia todos los días y NO está en la API de
// Biller. Por eso:
//   - el valor de la UI se configura (`BILLER_VALOR_UI`) y viene con fecha;
//   - si NO está configurado se usa un valor de referencia y se avisa que el
//     umbral es aproximado — nunca se calla el chequeo, porque un aviso
//     aproximado a tiempo vale más que un silencio exacto;
//   - el umbral en UI también es configurable (`BILLER_UMBRAL_UI_RECEPTOR`),
//     porque es una norma y las normas cambian sin avisarle a este código.
// =============================================================================

import {
  FORMAS_PAGO,
  TIPOS_COMPROBANTE,
  TIPOS_EXPORTACION,
  TIPOS_REMITO,
  TIPO_RESGUARDO,
  TIPOS_NOTA_AJUSTE,
} from "./cfeSchema.js";

/**
 * Familia e-Factura: DGI exige receptor identificado SIEMPRE, sin importar el
 * monto. Definida acá —y no en `cfeSchema.ts`— porque es una regla de DOMINIO,
 * no de forma del payload; `cfeSchema` la importa para validar.
 */
export const FAMILIA_EFACTURA = new Set([111, 112, 113, 121, 122, 123, 141, 142, 143]);

/** Familia e-Ticket: receptor opcional salvo que se supere el umbral en UI. */
export const FAMILIA_ETICKET = new Set([101, 102, 103, 131, 132, 133, 151, 152, 153]);

/** Umbral por defecto, en Unidades Indexadas, para exigir receptor en un e-Ticket. */
export const UMBRAL_UI_RECEPTOR_DEFAULT = 5000;

/**
 * Valor de referencia de la UI en pesos, usado SOLO si no hay uno configurado.
 * Está deliberadamente por lo BAJO respecto de la UI vigente: con un valor bajo
 * el umbral en pesos queda bajo, así que el aviso aparece de más y no de menos.
 * Equivocarse avisando de más cuesta una pregunta; de menos, un CFE mal emitido.
 */
export const VALOR_UI_REFERENCIA = 6;

export interface OpcionesUi {
  /** Pesos por Unidad Indexada. Si falta, se usa VALOR_UI_REFERENCIA y se avisa. */
  valor_ui?: number;
  /** Fecha del valor de UI (aaaa-mm-dd), para poder decir de cuándo es. */
  valor_ui_fecha?: string;
  /** Umbral en UI. Default 5000. */
  umbral_ui?: number;
}

export interface UmbralReceptor {
  umbral_ui: number;
  valor_ui: number;
  /** true si el valor de UI salió de configuración; false si es el de referencia. */
  valor_ui_configurado: boolean;
  valor_ui_fecha: string | null;
  /** Umbral convertido a pesos. */
  umbral_uyu: number;
  nota: string;
}

export function resolverUmbralReceptor(opciones: OpcionesUi = {}): UmbralReceptor {
  const umbral_ui = opciones.umbral_ui ?? UMBRAL_UI_RECEPTOR_DEFAULT;
  const configurado = typeof opciones.valor_ui === "number" && opciones.valor_ui > 0;
  const valor_ui = configurado ? opciones.valor_ui! : VALOR_UI_REFERENCIA;
  return {
    umbral_ui,
    valor_ui,
    valor_ui_configurado: configurado,
    valor_ui_fecha: opciones.valor_ui_fecha ?? null,
    umbral_uyu: Math.round(umbral_ui * valor_ui),
    nota: configurado
      ? `Umbral de ${umbral_ui} UI = $${Math.round(umbral_ui * valor_ui)} a una UI de $${valor_ui}` +
        (opciones.valor_ui_fecha !== undefined ? ` (valor del ${opciones.valor_ui_fecha}).` : ".")
      : `Umbral de ${umbral_ui} UI ≈ $${Math.round(umbral_ui * valor_ui)}, usando un valor de UI de ` +
        `REFERENCIA ($${VALOR_UI_REFERENCIA}) porque BILLER_VALOR_UI no está configurado. El valor real ` +
        "lo publica el INE/DGI y cambia a diario: configuralo para que el umbral sea exacto.",
  };
}

/**
 * ¿Este comprobante exige identificar al receptor?
 *
 * @param total Importe del comprobante EN PESOS. Si viene en otra moneda hay que
 *   convertirlo antes: el umbral es en UI, que es una unidad en pesos. Si no se
 *   puede convertir, pasá null y la respuesta lo dirá en vez de adivinar.
 */
export function exigeReceptor(
  tipo: number,
  totalUyu: number | null,
  opciones: OpcionesUi = {},
): { exige: boolean; motivo: string; umbral: UmbralReceptor; indeterminado: boolean } {
  const umbral = resolverUmbralReceptor(opciones);

  if (FAMILIA_EFACTURA.has(tipo)) {
    return {
      exige: true,
      motivo:
        `El tipo ${tipo} (${TIPOS_COMPROBANTE[tipo] ?? "?"}) es de la familia e-Factura: DGI exige ` +
        "receptor identificado con documento SIEMPRE, sin importar el monto.",
      umbral,
      indeterminado: false,
    };
  }

  if (!FAMILIA_ETICKET.has(tipo)) {
    return {
      exige: false,
      motivo: `El tipo ${tipo} no es e-Ticket ni e-Factura: no aplica la regla del umbral en UI.`,
      umbral,
      indeterminado: false,
    };
  }

  if (totalUyu === null) {
    return {
      exige: false,
      motivo:
        "No se pudo determinar el importe en pesos, así que NO se pudo verificar el umbral de " +
        `${umbral.umbral_ui} UI (~$${umbral.umbral_uyu}). Si el comprobante lo supera, el receptor ` +
        "es obligatorio.",
      umbral,
      indeterminado: true,
    };
  }

  const supera = totalUyu >= umbral.umbral_uyu;
  return {
    exige: supera,
    motivo: supera
      ? `El e-Ticket es por $${Math.round(totalUyu)} y supera el umbral de ${umbral.umbral_ui} UI ` +
        `(~$${umbral.umbral_uyu}): DGI exige identificar al receptor. ${umbral.nota}`
      : `El e-Ticket es por $${Math.round(totalUyu)}, por debajo del umbral de ${umbral.umbral_ui} UI ` +
        `(~$${umbral.umbral_uyu}): el receptor es opcional.`,
    umbral,
    indeterminado: false,
  };
}

// ---------------------------------------------------------------------------
// Catálogo de requisitos
// ---------------------------------------------------------------------------

export type Obligatoriedad = "siempre" | "condicional" | "recomendado";

export interface RequisitoCampo {
  campo: string;
  obligatoriedad: Obligatoriedad;
  /** Qué hace que sea obligatorio, cuando es condicional. */
  condicion?: string;
  /** Explicación en castellano, lista para mostrarle a una persona. */
  detalle: string;
  /** Pregunta a hacer si falta. Es lo que se manda por WhatsApp. */
  pregunta: string;
  ejemplo?: unknown;
}

function presente(body: Record<string, unknown>, campo: string): boolean {
  const partes = campo.split(".");
  let actual: unknown = body;
  for (const p of partes) {
    if (actual === null || actual === undefined || typeof actual !== "object") return false;
    actual = (actual as Record<string, unknown>)[p];
  }
  if (actual === null || actual === undefined) return false;
  if (typeof actual === "string") return actual.trim() !== "";
  if (Array.isArray(actual)) return actual.length > 0;
  return true;
}

export interface EvaluacionRequisitos {
  tipo_comprobante: number;
  etiqueta: string;
  /** Todo lo que puede hacer falta para este tipo, con su condición. */
  requisitos: RequisitoCampo[];
  /** Lo que falta AHORA, dado lo que ya se sabe. Ordenado por urgencia. */
  faltantes: RequisitoCampo[];
  /** true si no falta nada obligatorio. */
  listo_para_emitir: boolean;
  /**
   * La ÚNICA pregunta que conviene hacer ahora. Preguntar cinco cosas juntas por
   * WhatsApp es la forma más rápida de no recibir ninguna respuesta.
   */
  siguiente_pregunta: string | null;
  /** Reglas de DGI que aplican a este comprobante, explicadas. */
  reglas_dgi: string[];
  /** Esqueleto mínimo del cuerpo, para armar la llamada. */
  ejemplo_minimo: Record<string, unknown>;
  advertencias: string[];
}

export interface EvaluarRequisitosOptions extends OpcionesUi {
  /** Importe estimado en pesos, para evaluar el umbral de receptor. */
  total_uyu?: number | null;
  /** true si hay BILLER_DEFAULT_SUCURSAL_ID configurado (entonces no se pregunta). */
  sucursal_por_defecto?: boolean;
}

/**
 * Arma la lista de requisitos de un tipo de CFE y la contrasta con lo que ya se
 * sabe (`body` parcial, puede venir vacío).
 */
export function evaluarRequisitos(
  tipo: number,
  body: Record<string, unknown> = {},
  opciones: EvaluarRequisitosOptions = {},
): EvaluacionRequisitos {
  const etiqueta = TIPOS_COMPROBANTE[tipo] ?? `tipo ${tipo}`;
  const requisitos: RequisitoCampo[] = [];
  const reglas: string[] = [];
  const advertencias: string[] = [];

  // --- Siempre --------------------------------------------------------------
  requisitos.push({
    campo: "tipo_comprobante",
    obligatoriedad: "siempre",
    detalle: `Qué se emite. Acá: ${tipo} (${etiqueta}).`,
    pregunta: "¿Qué tipo de comprobante querés emitir: e-Ticket (101) o e-Factura (111)?",
    ejemplo: tipo,
  });
  requisitos.push({
    campo: "sucursal",
    obligatoriedad: "siempre",
    detalle:
      "ID REAL de la sucursal en Biller (Ajustes → Sucursales), no un número genérico. " +
      "Se puede fijar una vez en BILLER_DEFAULT_SUCURSAL_ID y no volver a preguntarla.",
    pregunta: "¿Desde qué sucursal se emite? (es el ID que figura en Ajustes → Sucursales)",
    ejemplo: 347,
  });
  requisitos.push({
    campo: "moneda",
    obligatoriedad: "siempre",
    detalle: "UYU, USD, ARS, BRL, EUR… Si no es UYU conviene fijar también tasa_cambio.",
    pregunta: "¿En qué moneda? (UYU o USD)",
    ejemplo: "UYU",
  });

  const esResguardo = tipo === TIPO_RESGUARDO;
  if (esResguardo) {
    requisitos.push({
      campo: "retencionesPercepciones",
      obligatoriedad: "siempre",
      detalle:
        "En un e-Resguardo las retenciones/percepciones cumplen el rol de los ítems: " +
        "código de DGI, tasa y monto sujeto.",
      pregunta: "¿Qué retención/percepción hay que documentar (código de DGI, tasa y monto sujeto)?",
    });
  } else {
    requisitos.push({
      campo: "items",
      obligatoriedad: "siempre",
      detalle:
        "Qué se vende: cada ítem con concepto, cantidad, precio e indicador_facturacion " +
        "(3 = tasa básica 22%, 2 = mínima 10%, 1 = exento).",
      pregunta: "¿Qué le facturo? Necesito concepto, cantidad y precio unitario de cada ítem.",
      ejemplo: [{ concepto: "Servicio de consultoría", cantidad: 1, precio: 5000, indicador_facturacion: 3 }],
    });
  }

  // --- Receptor -------------------------------------------------------------
  const receptor = exigeReceptor(tipo, opciones.total_uyu ?? null, opciones);
  if (receptor.indeterminado) {
    advertencias.push(receptor.motivo);
  }
  requisitos.push({
    campo: "cliente",
    obligatoriedad: receptor.exige ? "siempre" : "recomendado",
    condicion: receptor.exige ? undefined : `Obligatorio si supera ${receptor.umbral.umbral_ui} UI (~$${receptor.umbral.umbral_uyu}).`,
    detalle: receptor.motivo,
    pregunta: receptor.exige
      ? "¿A quién se lo facturo? Necesito RUT (o CI), razón social, dirección y ciudad."
      : "¿Va con datos del cliente? (opcional en este caso; si supera el umbral, pasa a ser obligatorio)",
    ejemplo: {
      tipo_documento: 2,
      documento: "217832560011",
      razon_social: "Carbonell SA",
      sucursal: { direccion: "Av. Italia 1234", ciudad: "Montevideo", pais: "UY" },
    },
  });

  // VERIFICADO CONTRA LA API: emitir con un cliente nuevo sin dirección/ciudad
  // devuelve 422. La doc dice que `pais` es el único obligatorio; no lo es
  // cuando el cliente se da de alta en la misma llamada de emisión.
  if (receptor.exige) {
    requisitos.push({
      campo: "cliente.sucursal.direccion",
      obligatoriedad: "condicional",
      condicion: "Cliente nuevo (se da de alta al emitir)",
      detalle:
        "Biller responde 422 \"Dirección no puede estar vacío\" si el cliente no existe todavía. " +
        "Si el cliente YA está cargado en Biller, no hace falta reenviarla.",
      pregunta: "¿Cuál es la dirección del cliente?",
      ejemplo: "Av. Italia 1234",
    });
    requisitos.push({
      campo: "cliente.sucursal.ciudad",
      obligatoriedad: "condicional",
      condicion: "Cliente nuevo (se da de alta al emitir)",
      detalle: "Mismo caso que la dirección: 422 \"Ciudad no puede estar vacío\".",
      pregunta: "¿En qué ciudad?",
      ejemplo: "Montevideo",
    });
  }
  reglas.push(receptor.motivo);
  if (!receptor.umbral.valor_ui_configurado) {
    advertencias.push(receptor.umbral.nota);
  }

  // --- Condicionales por tipo ----------------------------------------------
  if (TIPOS_EXPORTACION.has(tipo)) {
    for (const [campo, detalle, pregunta] of [
      ["modalidad_venta", "1 Régimen General, 2 Consignación, 90 Exportación de servicios…", "¿Qué modalidad de venta? (1 = régimen general)"],
      ["clausula_venta", "Incoterm de 3 letras: FOB, CIF, EXW…", "¿Qué cláusula de venta? (FOB, CIF, EXW…)"],
      ["via_transporte", "1 Marítimo, 2 Aéreo, 3 Terrestre, 8 N/A", "¿Por qué vía se transporta? (1 marítimo, 2 aéreo, 3 terrestre)"],
    ] as const) {
      requisitos.push({
        campo,
        obligatoriedad: "siempre",
        condicion: "Exportación",
        detalle,
        pregunta,
      });
    }
    requisitos.push({
      campo: "items[].ncm",
      obligatoriedad: "siempre",
      condicion: "Exportación",
      detalle: "Posición arancelaria de cada ítem.",
      pregunta: "¿Cuál es la posición arancelaria (NCM) de cada ítem?",
    });
    reglas.push("En exportaciones, modalidad_venta, clausula_venta, via_transporte y el NCM de cada ítem son obligatorios.");
  }

  if (TIPOS_REMITO.has(tipo)) {
    requisitos.push({
      campo: "tipo_traslado",
      obligatoriedad: "siempre",
      condicion: "Remitos",
      detalle: "1 = Venta, 2 = Traslados internos.",
      pregunta: "¿El remito es por una venta (1) o un traslado interno (2)?",
    });
    reglas.push("Los remitos exigen tipo_traslado.");
  }

  if (TIPOS_NOTA_AJUSTE.has(tipo)) {
    requisitos.push({
      campo: "referencias",
      obligatoriedad: "siempre",
      condicion: "Notas de crédito y débito",
      detalle:
        "A qué comprobante ajusta. Se puede pasar el id de Biller ([100]), la terna " +
        "[{tipo, serie, numero}], o referencia_global + razon_referencia si no se asocia a uno puntual.",
      pregunta: "¿Sobre qué comprobante es la nota? Decime el id, o tipo + serie + número.",
      ejemplo: [{ tipo: 111, serie: "A", numero: 1 }],
    });
    reglas.push(
      "Una nota de ajuste sin referencia al CFE original suele ser rechazada por DGI. " +
        "'referencias' y 'referencia_global' son mutuamente excluyentes.",
    );
  }

  if ([131, 132, 133, 141, 142, 143].includes(tipo)) {
    requisitos.push({
      campo: "complementoFiscal",
      obligatoriedad: "siempre",
      condicion: "Venta por cuenta ajena",
      detalle: "Datos del mandante: nombre, tipo_documento, documento y país.",
      pregunta: "¿Por cuenta de quién vendés? Necesito nombre y RUT del mandante.",
    });
    reglas.push("La venta por cuenta ajena requiere complementoFiscal con el mandante.");
  }

  // --- Recomendados ---------------------------------------------------------
  requisitos.push({
    campo: "numero_interno",
    obligatoriedad: "recomendado",
    detalle:
      "Identificador propio del comprobante. Es lo ÚNICO que permite detectar un duplicado si la " +
      "llamada se reintenta: sin esto, un reintento emite dos veces.",
    pregunta: "¿Le pongo una referencia interna? (recomendado: evita emitir dos veces por un reintento)",
  });
  requisitos.push({
    campo: "forma_pago",
    obligatoriedad: "recomendado",
    detalle: `1 = ${FORMAS_PAGO[1]}, 2 = ${FORMAS_PAGO[2]}. Define si genera cuenta corriente.`,
    pregunta: "¿Es contado o crédito?",
  });
  if (body.forma_pago === 2) {
    requisitos.push({
      campo: "fecha_vencimiento",
      obligatoriedad: "siempre",
      condicion: "forma_pago = 2 (crédito)",
      detalle: "Sin vencimiento, la venta a crédito no aparece en cobranzas ni en la cuenta corriente.",
      pregunta: "¿Cuándo vence? (dd/mm/aaaa)",
    });
  }

  // --- Contraste con lo que ya se sabe -------------------------------------
  const yaTieneSucursal = presente(body, "sucursal") || opciones.sucursal_por_defecto === true;
  const faltantes = requisitos.filter((r) => {
    if (r.obligatoriedad === "recomendado") return false;
    // El tipo es el parámetro de esta función: por definición ya se sabe. Sigue
    // en la lista de requisitos porque es información útil, pero pedirlo de
    // vuelta sería preguntar lo que el usuario acaba de contestar.
    if (r.campo === "tipo_comprobante") return false;
    if (r.campo === "sucursal") return !yaTieneSucursal;
    if (r.campo.includes("[]")) {
      // items[].ncm y similares: se considera cubierto si hay items y todos lo traen.
      const [raiz, sub] = r.campo.split("[].");
      const arr = body[raiz!];
      if (!Array.isArray(arr) || arr.length === 0) return true;
      return !arr.every((i) => presente(i as Record<string, unknown>, sub!));
    }
    return !presente(body, r.campo);
  });

  return {
    tipo_comprobante: tipo,
    etiqueta,
    requisitos,
    faltantes,
    listo_para_emitir: faltantes.length === 0,
    siguiente_pregunta: faltantes[0]?.pregunta ?? null,
    reglas_dgi: reglas,
    ejemplo_minimo: ejemploMinimo(tipo, opciones),
    advertencias,
  };
}

/** Esqueleto mínimo válido para el tipo pedido. No inventa datos del cliente. */
function ejemploMinimo(tipo: number, opciones: EvaluarRequisitosOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    tipo_comprobante: tipo,
    sucursal: "<ID real de tu sucursal>",
    moneda: "UYU",
    forma_pago: 1,
    numero_interno: "<referencia propia, única>",
    items: [
      { concepto: "<qué vendés>", cantidad: 1, precio: 1000, indicador_facturacion: 3 },
    ],
  };
  if (exigeReceptor(tipo, opciones.total_uyu ?? null, opciones).exige) {
    base.cliente = {
      tipo_documento: 2,
      documento: "<RUT sin puntos ni guiones>",
      razon_social: "<razón social>",
      sucursal: { pais: "UY" },
    };
  }
  if (TIPOS_NOTA_AJUSTE.has(tipo)) {
    base.referencias = [{ tipo: 111, serie: "<serie del original>", numero: 0 }];
  }
  if (TIPOS_REMITO.has(tipo)) base.tipo_traslado = 1;
  if (TIPOS_EXPORTACION.has(tipo)) {
    base.modalidad_venta = 1;
    base.clausula_venta = "FOB";
    base.via_transporte = 1;
  }
  return base;
}
