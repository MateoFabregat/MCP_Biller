// =============================================================================
// Schema tipado del cuerpo de un CFE  ->  POST /v3/comprobantes/emitir
//
// Fuente de verdad: "Tabla de valores" de la documentación oficial de Biller
// (api.json, sección POST /v3/comprobantes/emitir). Cada enum, cada límite de
// longitud y cada regla de obligatoriedad de este archivo sale de esa tabla.
//
// Criterio de estrictez (deliberado):
//   - ERROR   : solo donde la doc dice "Obligatorio" o "Mutuamente excluyente".
//               Son reglas inequívocas; dejarlas pasar produce un 422 de Biller
//               o —peor— un CFE rechazado por DGI con el número ya consumido.
//   - WARNING : todo lo demás (ver `validarComprobante` en este mismo archivo).
//               Se informa en el preview y el humano decide.
//   - PASSTHROUGH: los campos no documentados se conservan tal cual. La doc no
//               es un JSON Schema estricto, así que nunca descartamos datos.
// =============================================================================

import { z } from "zod";
import { booleano, codigo, entero, numero, texto } from "./coerce.js";
import { FAMILIA_EFACTURA, FAMILIA_ETICKET, exigeReceptor } from "./requisitos.js";

// ---------------------------------------------------------------------------
// Tablas de valores documentadas
// ---------------------------------------------------------------------------

export const TIPOS_COMPROBANTE: Record<number, string> = {
  101: "e-Ticket",
  102: "Nota de crédito de e-Ticket",
  103: "Nota de débito de e-Ticket",
  111: "e-Factura",
  112: "Nota de crédito de e-Factura",
  113: "Nota de débito de e-Factura",
  121: "e-Factura de exportación",
  122: "Nota de crédito de e-Factura de exportación",
  123: "Nota de débito de e-Factura de exportación",
  124: "eRemito de exportación",
  131: "e-Ticket Venta por cuenta ajena",
  132: "NC e-Ticket Venta por cuenta ajena",
  133: "ND e-Ticket venta por cuenta ajena",
  141: "e-Factura Venta por cuenta ajena",
  142: "NC e-Factura Venta por cuenta ajena",
  143: "ND e-Factura venta por cuenta ajena",
  151: "eBoleta de entrada",
  152: "NC eBoleta de entrada",
  153: "ND eBoleta de entrada",
  181: "eRemito",
  182: "eResguardo",
};

export const FORMAS_PAGO: Record<number, string> = {
  1: "Contado",
  2: "Crédito",
};

/** Indicador de facturación del ítem (define el tratamiento de IVA ante DGI). */
export const INDICADORES_FACTURACION: Record<number, string> = {
  1: "Exento de IVA",
  2: "Tasa mínima",
  3: "Tasa básica",
  4: "Otra tasa",
  5: "Entrega gratuita",
  6: "Producto o servicio no facturable",
  7: "Producto o servicio no facturable negativo",
  8: "Ítem a rebajar en e-remitos y en e-remitos de exportación",
  9: "Ítem a anular en resguardos",
  10: "Exportación y asimiladas",
  11: "Impuesto percibido",
  12: "IVA en suspenso",
  13: "Ítem vendido no contribuyente",
  14: "Ítem vendido contribuyente monotributo",
  15: "Ítem vendido contribuyente IMEBA",
  16: "Ítem vendido contribuyente IVA mínimo, Monotributo o Monotributo MIDES",
};

export const TIPOS_DOCUMENTO: Record<number, string> = {
  2: "RUT",
  3: "CI",
  4: "Otro",
  5: "Pasaporte",
  6: "DNI",
  7: "NIFE",
};

export const MODALIDADES_VENTA: Record<number, string> = {
  1: "Régimen General",
  2: "Consignación",
  3: "Precio Revisable",
  4: "Bienes propios a exclaves aduaneros",
  80: "Régimen TAX FREE",
  90: "Régimen general - exportación de servicios",
  99: "Otras transacciones",
};

export const VIAS_TRANSPORTE: Record<number, string> = {
  1: "Marítimo",
  2: "Aéreo",
  3: "Terrestre",
  8: "N/A",
  9: "Otro",
};

export const TIPOS_TRASLADO: Record<number, string> = {
  1: "Venta",
  2: "Traslados internos",
};

export const CLAUSULAS_VENTA = [
  "CFR", "CIF", "CIP", "CPT", "DAP", "DAT", "DDP",
  "DDU", "EXW", "FAS", "FCA", "FOB", "N/A",
] as const;

/** R = responsable sobre el producto/servicio; A = sobre un concepto asociado. */
export const INDICADORES_AGENTE_RESPONSABLE = ["R", "A"] as const;

// --- Conjuntos derivados usados por las reglas de negocio -------------------

/** Exportación y sus notas de ajuste + eRemito de exportación. */
export const TIPOS_EXPORTACION = new Set([121, 122, 123, 124]);
/** Remitos (exigen `tipo_traslado`). */
export const TIPOS_REMITO = new Set([181, 124]);
/** e-Resguardo: las retenciones/percepciones cumplen el rol de ítems. */
export const TIPO_RESGUARDO = 182;
/** Notas de ajuste: requieren referenciar el CFE original. */
export const TIPOS_NOTA_AJUSTE = new Set([
  102, 103, 112, 113, 122, 123, 132, 133, 142, 143, 152, 153,
]);
/**
 * CFE donde la doc prohíbe retenciones/percepciones:
 * "salvo e-Remitos, e-Remitos de Exportación y e-Factura de Exportación
 *  (y sus notas de ajuste)".
 */
export const TIPOS_SIN_RETENCIONES = new Set([181, 124, 121, 122, 123]);

// ---------------------------------------------------------------------------
// Fechas: formato dd/mm/aaaa (NO ISO)
// ---------------------------------------------------------------------------

const RE_ISO = /^\d{4}-\d{2}-\d{2}/;
const RE_DDMMAAAA = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Mínimo documentado para `fecha_emision`. */
export const FECHA_EMISION_MINIMA = "01/10/2011";

/** Parsea dd/mm/aaaa validando que sea una fecha real. Devuelve null si no lo es. */
export function parseFechaDgi(value: string): Date | null {
  const m = RE_DDMMAAAA.exec(value.trim());
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  // Rechaza 31/02/2026 y similares: Date "corrige" el desborde en silencio.
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return d;
}

/** Formatea un Date como dd/mm/aaaa (el formato que espera Biller). */
export function formatFechaDgi(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function fechaDgi(campo: string) {
  return z.string().superRefine((value, ctx) => {
    if (RE_ISO.test(value.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${campo} está en formato ISO (aaaa-mm-dd). Biller espera dd/mm/aaaa. ` +
          `Ejemplo: "31/12/2026". Ojo: los filtros de LECTURA sí usan aaaa-mm-dd; ` +
          "los de emisión no.",
      });
      return;
    }
    if (parseFechaDgi(value) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${campo} debe tener formato dd/mm/aaaa y ser una fecha real (ej: "31/12/2026").`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Sub-objetos
// ---------------------------------------------------------------------------

export const SucursalClienteSchema = z
  .object({
    direccion: texto(70, "cliente.sucursal.direccion").optional(),
    ciudad: texto(30, "cliente.sucursal.ciudad").optional(),
    departamento: texto(30, "cliente.sucursal.departamento").optional(),
    // "Único campo obligatorio para clientes que no son empresas".
    pais: z.string().optional().describe("UY, AR, BR, US, PY, CL, ..."),
    emails: z.array(z.string().email("Email inválido en cliente.sucursal.emails")).optional(),
    sustituir_emails: booleano().optional(),
  })
  .passthrough();

export const ClienteSchema = z
  .object({
    razon_social: texto(70, "cliente.razon_social")
      .optional()
      .describe("Nombre principal para tipo_documento 2 (RUT) y 7 (NIFE)."),
    nombre_fantasia: texto(30, "cliente.nombre_fantasia")
      .optional()
      .describe("Nombre principal para tipo_documento 3 (CI), 5 (Pasaporte) y 6 (DNI)."),
    tipo_documento: codigo(TIPOS_DOCUMENTO, "cliente.tipo_documento").optional(),
    documento: z.string().optional().describe("Sin puntos ni guiones."),
    pais: z.string().optional(),
    informacion_adicional: texto(150, "cliente.informacion_adicional").optional(),
    sucursal: SucursalClienteSchema.optional(),
  })
  .passthrough();

/** `cliente` admite el objeto receptor o el literal "-" (CFE sin receptor). */
export const ClienteOSinReceptorSchema = z.union([z.string(), ClienteSchema]);

export const RetencionPercepcionSchema = z
  .object({
    codigo: entero("retencionesPercepciones.codigo").describe(
      "Código de retención/percepción registrado en DGI (formulario + línea).",
    ),
    tasa: numero("tasa"),
    monto_sujeto: numero("monto_sujeto"),
    indicador_facturacion: codigo(
      INDICADORES_FACTURACION,
      "retencionesPercepciones.indicador_facturacion",
    ).optional(),
  })
  .passthrough();

export const ItemSchema = z
  .object({
    codigo: z.union([texto(35, "items.codigo"), z.number()]).optional(),
    cantidad: numero("items.cantidad"),
    concepto: texto(80, "items.concepto"),
    precio: numero("items.precio").optional(),
    unidad_medida: texto(4, "items.unidad_medida").optional(),
    codigo_ean: entero("items.codigo_ean").optional(),
    codigo_dun: entero("items.codigo_dun").optional(),
    codigo_gtin_13: z
      .string()
      .regex(/^\d{1,13}$/, "items.codigo_gtin_13 debe tener solo dígitos (máximo 13).")
      .optional(),
    ncm: texto(20, "items.ncm").optional().describe("Posición arancelaria. Obligatoria en exportaciones."),
    indicador_facturacion: codigo(INDICADORES_FACTURACION, "items.indicador_facturacion").optional(),
    descripcion: z.string().optional(),
    descuento_tipo: z.enum(["$", "%"], {
      errorMap: () => ({ message: 'items.descuento_tipo debe ser "$" o "%".' }),
    }).optional(),
    descuento_cantidad: numero("items.descuento_cantidad").optional(),
    recargo_tipo: z.enum(["$", "%"], {
      errorMap: () => ({ message: 'items.recargo_tipo debe ser "$" o "%".' }),
    }).optional(),
    recargo_cantidad: numero("items.recargo_cantidad").optional(),
    indicador_agente_responsable: z.enum(INDICADORES_AGENTE_RESPONSABLE, {
      errorMap: () => ({
        message:
          'items.indicador_agente_responsable debe ser "R" (responsable sobre el producto/servicio) ' +
          'o "A" (sobre un concepto asociado).',
      }),
    }).optional(),
    retencionesPercepciones: z.array(RetencionPercepcionSchema).optional(),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    // "Debe incluirse cuando el CFE no e-Resguardo incluye Retenciones/Percepciones."
    // El chequeo por tipo de CFE se hace arriba; acá validamos el par tipo/cantidad.
    if (item.descuento_tipo !== undefined && item.descuento_cantidad === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "items.descuento_tipo requiere items.descuento_cantidad.",
        path: ["descuento_cantidad"],
      });
    }
    if (item.recargo_tipo !== undefined && item.recargo_cantidad === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "items.recargo_tipo requiere items.recargo_cantidad.",
        path: ["recargo_cantidad"],
      });
    }
    if (item.descuento_tipo === "%" && (item.descuento_cantidad ?? 0) > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "items.descuento_cantidad en % no puede superar 100.",
        path: ["descuento_cantidad"],
      });
    }
  });

export const DescuentoRecargoGlobalSchema = z
  .object({
    es_recargo: booleano(),
    desc_rec_tipo: z.enum(["$", "%"], {
      errorMap: () => ({ message: 'descuentosRecargos.desc_rec_tipo debe ser "$" o "%".' }),
    }),
    glosa: texto(50, "descuentosRecargos.glosa").optional(),
    valor: numero("descuentosRecargos.valor"),
    indicador_facturacion: codigo(
      INDICADORES_FACTURACION,
      "descuentosRecargos.indicador_facturacion",
    ).describe("Debe coincidir con el del ítem o ítems que se desea afectar."),
  })
  .passthrough();

/**
 * `referencias` acepta las tres formas documentadas:
 *   [100]                                        -> ID del CFE en Biller
 *   [{ tipo, serie, numero }]                    -> CFE emitido en Biller
 *   [{ tipo, serie, numero, fecha }]             -> CFE externo (fecha ISO)
 * y se pueden combinar en el mismo array.
 */
export const ReferenciaSchema = z.union([
  entero("referencias (ID del CFE)"),
  z
    .object({
      tipo: codigo(TIPOS_COMPROBANTE, "referencias.tipo"),
      serie: z.string(),
      numero: entero("referencias.numero"),
      fecha: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}$/,
          'referencias.fecha usa formato ISO aaaa-mm-dd (ej: "2020-01-01"), a diferencia de fecha_emision.',
        )
        .optional(),
    })
    .passthrough(),
]);

export const CaeEspecialSchema = z
  .object({
    especial: entero("cae.especial"),
    causal_especial: entero("cae.causal_especial"),
  })
  .passthrough();

export const ComplementoFiscalSchema = z
  .object({
    nombre: texto(255, "complementoFiscal.nombre"),
    tipo_documento: codigo(TIPOS_DOCUMENTO, "complementoFiscal.tipo_documento"),
    documento: texto(255, "complementoFiscal.documento").describe("Sin puntos ni guiones."),
    pais: texto(2, "complementoFiscal.pais"),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Cuerpo del CFE
// ---------------------------------------------------------------------------

export const ComprobanteBodySchema = z
  .object({
    tipo_comprobante: codigo(TIPOS_COMPROBANTE, "tipo_comprobante"),
    numero_interno: z
      .string()
      .optional()
      .describe("Identificador propio de la empresa. Debe ser ÚNICO (sirve para deduplicar)."),
    forma_pago: codigo(FORMAS_PAGO, "forma_pago").optional(),
    fecha_emision: fechaDgi("fecha_emision")
      .optional()
      .describe(`dd/mm/aaaa. Mínimo ${FECHA_EMISION_MINIMA}, máximo dos meses a futuro.`),
    fecha_vencimiento: fechaDgi("fecha_vencimiento").optional().describe("dd/mm/aaaa."),
    sucursal: entero("sucursal").optional().describe("ID real de la sucursal en Biller."),
    moneda: z.string().optional().describe("UYU, USD, ARS, BRL, EUR, ..."),
    tasa_cambio: numero("tasa_cambio")
      .optional()
      .describe("Si se omite, Biller toma la cotización de cierre anterior a fecha_emision."),
    montos_brutos: booleano().optional().describe("true/1 = los precios de los ítems YA incluyen IVA."),
    numero_compra: texto(50, "numero_compra").optional(),
    lugar_entrega: z.string().optional(),
    cliente: ClienteOSinReceptorSchema.optional(),
    items: z.array(ItemSchema).optional(),
    descuentosRecargos: z.array(DescuentoRecargoGlobalSchema).optional(),
    referencia_global: booleano().optional(),
    razon_referencia: z.string().optional(),
    referencias: z.array(ReferenciaSchema).optional(),
    tipo_traslado: codigo(TIPOS_TRASLADO, "tipo_traslado").optional(),
    adenda: z.string().optional(),
    informacion_adicional: texto(150, "informacion_adicional").optional(),
    modalidad_venta: codigo(MODALIDADES_VENTA, "modalidad_venta").optional(),
    clausula_venta: z.enum(CLAUSULAS_VENTA, {
      errorMap: () => ({
        message: `clausula_venta debe ser uno de: ${CLAUSULAS_VENTA.join(", ")}.`,
      }),
    }).optional(),
    via_transporte: codigo(VIAS_TRANSPORTE, "via_transporte").optional(),
    indicador_pagos_terceros: booleano().optional(),
    emails_notificacion: z
      .array(z.string().email("Email inválido en emails_notificacion"))
      .optional(),
    retencionesPercepciones: z.array(RetencionPercepcionSchema).optional(),
    cae: CaeEspecialSchema.optional(),
    complementoFiscal: ComplementoFiscalSchema.optional(),
  })
  .passthrough()
  .superRefine(reglasObligatorias);

export type ComprobanteBody = z.infer<typeof ComprobanteBodySchema>;

// ---------------------------------------------------------------------------
// Reglas de obligatoriedad (ERROR — la doc las declara explícitamente)
// ---------------------------------------------------------------------------

function reglasObligatorias(body: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const tipo = body.tipo_comprobante as number | undefined;
  const items = body.items as Array<Record<string, unknown>> | undefined;

  // 1. "Mutuamente excluyente con referencias" / "...con referencia_global".
  const tieneReferencias = Array.isArray(body.referencias) && body.referencias.length > 0;
  const usaGlobal = body.referencia_global === true;
  if (tieneReferencias && usaGlobal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "'referencias' y 'referencia_global' son mutuamente excluyentes: enviá una u otra, no ambas.",
      path: ["referencia_global"],
    });
  }

  // 2. "Obligatorio en caso de tener referencia_global".
  if (usaGlobal) {
    const razon = body.razon_referencia;
    if (typeof razon !== "string" || razon.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'razon_referencia' es obligatorio cuando se usa 'referencia_global'.",
        path: ["razon_referencia"],
      });
    }
  }

  if (typeof tipo !== "number") return;

  // 3. "Obligatorio sólo en exportaciones": modalidad_venta, clausula_venta, via_transporte.
  //    Se aplica a TODA la familia de exportación, incluido el eRemito de
  //    exportación (124): la doc no hace excepciones y no vamos a inventar una.
  if (TIPOS_EXPORTACION.has(tipo)) {
    for (const campo of ["modalidad_venta", "clausula_venta", "via_transporte"] as const) {
      if (body[campo] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'${campo}' es obligatorio en comprobantes de exportación (tipo ${tipo}).`,
          path: [campo],
        });
      }
    }
    // "ncm: Obligatorio sólo en exportaciones."
    items?.forEach((item, i) => {
      if (item.ncm === undefined || item.ncm === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'ncm' (posición arancelaria) es obligatorio en cada ítem de una exportación.`,
          path: ["items", i, "ncm"],
        });
      }
    });
  }

  // 4. "Obligatorio para remitos": tipo_traslado.
  if (TIPOS_REMITO.has(tipo) && body.tipo_traslado === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `'tipo_traslado' es obligatorio para remitos (tipo ${tipo}). 1 = Venta, 2 = Traslados internos.`,
      path: ["tipo_traslado"],
    });
  }

  // 5. Retenciones/percepciones: prohibidas en e-Remitos y exportación.
  const retenGlobal = body.retencionesPercepciones;
  const itemsConReten = items?.some(
    (i) => Array.isArray(i.retencionesPercepciones) && i.retencionesPercepciones.length > 0,
  );
  const hayRetenciones =
    (Array.isArray(retenGlobal) && retenGlobal.length > 0) || itemsConReten === true;
  if (hayRetenciones && TIPOS_SIN_RETENCIONES.has(tipo)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `El tipo ${tipo} (${TIPOS_COMPROBANTE[tipo]}) no admite retenciones/percepciones: ` +
        "la doc las excluye en e-Remitos, e-Remitos de exportación y e-Factura de exportación (y sus notas de ajuste).",
      path: ["retencionesPercepciones"],
    });
  }

  // 6. "indicador_agente_responsable debe incluirse cuando el CFE no e-Resguardo
  //     incluye Retenciones/Percepciones."
  if (tipo !== TIPO_RESGUARDO) {
    items?.forEach((item, i) => {
      const tiene = Array.isArray(item.retencionesPercepciones) && item.retencionesPercepciones.length > 0;
      if (tiene && item.indicador_agente_responsable === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "'indicador_agente_responsable' (R o A) es obligatorio en un ítem con retenciones/percepciones " +
            "cuando el CFE no es un e-Resguardo.",
          path: ["items", i, "indicador_agente_responsable"],
        });
      }
    });
  }

  // 7. fecha_emision: mínimo 01/10/2011, máximo dos meses a futuro.
  const fe = body.fecha_emision;
  if (typeof fe === "string") {
    const d = parseFechaDgi(fe);
    const minima = parseFechaDgi(FECHA_EMISION_MINIMA);
    if (d !== null && minima !== null) {
      if (d.getTime() < minima.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'fecha_emision' no puede ser anterior a ${FECHA_EMISION_MINIMA}.`,
          path: ["fecha_emision"],
        });
      }
      const limite = new Date(); // fecha-uy:allow es un techo de DOS MESES a futuro; tres horas de desfasaje no mueven la validación
      limite.setUTCMonth(limite.getUTCMonth() + 2);
      if (d.getTime() > limite.getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `'fecha_emision' no puede superar los dos meses a futuro (límite: ${formatFechaDgi(limite)}).`,
          path: ["fecha_emision"],
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Validaciones no bloqueantes (WARNING)
//
// Reglas que la doc sugiere o que DGI aplica, pero que no están declaradas como
// "Obligatorio". Se muestran en el preview para que el humano decida.
// ---------------------------------------------------------------------------

// La familia e-Factura vive en `requisitos.ts` junto a la regla que la usa (DGI
// exige receptor identificado siempre). Tenerla dos veces es tener dos
// definiciones de "qué comprobante necesita receptor": si divergen, una de las
// dos emite un CFE mal formado sin que nada avise.

function tieneReceptor(cliente: unknown): boolean {
  if (cliente === undefined || cliente === null) return false;
  if (typeof cliente === "string") return cliente.trim() !== "" && cliente.trim() !== "-";
  if (Array.isArray(cliente)) return cliente.length > 0;
  if (typeof cliente === "object") return Object.keys(cliente as object).length > 0;
  return false;
}

/**
 * Contexto opcional para las reglas que dependen de datos que no están en el
 * cuerpo del comprobante: el importe calculado y el valor de la UI.
 */
export interface ValidarComprobanteContexto {
  /** Total estimado EN PESOS. Habilita el chequeo del umbral de receptor. */
  total_uyu?: number | null;
  valor_ui?: number;
  valor_ui_fecha?: string;
  umbral_ui?: number;
}

export function validarComprobante(
  body: ComprobanteBody,
  contexto: ValidarComprobanteContexto = {},
): string[] {
  const warnings: string[] = [];
  const tipo = body.tipo_comprobante;
  const etiqueta = TIPOS_COMPROBANTE[tipo] ?? `tipo ${tipo}`;
  const items = body.items ?? [];

  if (body.sucursal === undefined) {
    warnings.push(
      "Falta 'sucursal': Biller la exige para emitir. Pasala en el cuerpo o configurá " +
        "BILLER_DEFAULT_SUCURSAL_ID con el ID real (Ajustes → Sucursales en biller.uy).",
    );
  }

  // e-Resguardo: las retenciones cumplen el rol de ítems.
  if (tipo === TIPO_RESGUARDO) {
    const reten = body.retencionesPercepciones ?? [];
    if (reten.length === 0) {
      warnings.push(
        "Un e-Resguardo (182) se compone de 'retencionesPercepciones' (cumplen el rol de ítems) y no trae ninguna.",
      );
    }
  } else if (items.length === 0) {
    warnings.push(
      `El comprobante ${tipo} (${etiqueta}) no incluye 'items'. Biller lo rechazará salvo que sea un caso especial.`,
    );
  }

  // Notas de ajuste sin referencia al CFE original.
  if (TIPOS_NOTA_AJUSTE.has(tipo)) {
    const tieneRef = (body.referencias?.length ?? 0) > 0 || body.referencia_global === true;
    if (!tieneRef) {
      warnings.push(
        `El comprobante ${tipo} (${etiqueta}) es una nota de ajuste sin referencia al CFE original ` +
          "('referencias' o 'referencia_global' + 'razon_referencia'). DGI suele rechazarla.",
      );
    }
  }

  // e-Factura sin receptor.
  if (FAMILIA_EFACTURA.has(tipo) && !tieneReceptor(body.cliente)) {
    warnings.push(
      `El comprobante ${tipo} (${etiqueta}) es de la familia e-Factura: DGI exige receptor identificado ` +
        "con documento. Falta 'cliente' (o vino vacío / \"-\").",
    );
  }

  // e-Ticket por encima del umbral en UI sin receptor. Es la regla que más se
  // olvida: al mostrador nadie pide el RUT, y por encima del umbral hay que
  // pedirlo. Se evalúa acá —y no en el schema— porque depende del importe
  // calculado y del valor de la UI, que no viven en el cuerpo del comprobante.
  //
  // La distinción entre `total_uyu` ausente y `total_uyu: null` es deliberada:
  //   - ausente  -> el llamador ni siquiera intentó calcular el importe. No es
  //     un hallazgo, es que no aplica; avisar acá sería ruido en cada e-Ticket.
  //   - null     -> se intentó y no se pudo (típicamente moneda extranjera sin
  //     cotización). Eso SÍ hay que decirlo: significa que la regla quedó sin
  //     verificar sobre un comprobante que podría necesitar receptor.
  if (
    FAMILIA_ETICKET.has(tipo) &&
    !tieneReceptor(body.cliente) &&
    "total_uyu" in contexto
  ) {
    const chequeo = exigeReceptor(tipo, contexto.total_uyu ?? null, {
      valor_ui: contexto.valor_ui,
      valor_ui_fecha: contexto.valor_ui_fecha,
      umbral_ui: contexto.umbral_ui,
    });
    if (chequeo.exige) {
      warnings.push(
        `⚠️ RECEPTOR OBLIGATORIO: ${chequeo.motivo} Este comprobante va SIN cliente identificado. ` +
          "Agregá 'cliente' con tipo_documento y documento antes de emitir.",
      );
    } else if (chequeo.indeterminado) {
      warnings.push(
        `No se pudo verificar el umbral de receptor: ${chequeo.motivo} ` +
          "El comprobante va sin cliente identificado.",
      );
    }
  }

  // Nombre principal según tipo de documento (tabla "Cliente").
  const cliente = body.cliente;
  if (cliente !== undefined && typeof cliente === "object" && cliente !== null) {
    const c = cliente as Record<string, unknown>;
    const td = c.tipo_documento;
    if ((td === 2 || td === 7) && !c.razon_social) {
      warnings.push(
        "Para tipo_documento 2 (RUT) o 7 (NIFE) el nombre principal es 'razon_social', y no vino.",
      );
    }
    if ((td === 3 || td === 5 || td === 6) && !c.nombre_fantasia) {
      warnings.push(
        "Para tipo_documento 3 (CI), 5 (Pasaporte) o 6 (DNI) el nombre principal es 'nombre_fantasia', y no vino.",
      );
    }
    const suc = c.sucursal as Record<string, unknown> | undefined;
    if (suc !== undefined && !suc.pais) {
      warnings.push(
        "'cliente.sucursal.pais' es el único campo obligatorio para clientes que no son empresas, y no vino.",
      );
    }
    // VERIFICADO CONTRA LA API (2026-07-28): la doc dice que `pais` es "el único
    // campo obligatorio", pero al emitir con un cliente sin dirección Biller
    // responde 422 "ClientesSucursales[direccion]: Dirección no puede estar
    // vacío. | ClientesSucursales[ciudad]: Ciudad no puede estar vacío.".
    // Pasa porque el alta del cliente ocurre como efecto del propio POST de
    // emisión, y esa entidad tiene sus propias reglas. Avisarlo acá convierte un
    // 422 críptico —que llega DESPUÉS de armar todo— en algo que se ve en el
    // preview, antes de emitir.
    if (suc !== undefined) {
      const faltan = (["direccion", "ciudad"] as const).filter((k) => {
        const v = suc[k];
        return typeof v !== "string" || v.trim() === "";
      });
      if (faltan.length > 0) {
        warnings.push(
          `Falta ${faltan.map((f) => `'cliente.sucursal.${f}'`).join(" y ")}. La doc no los marca ` +
            "como obligatorios, pero Biller rechaza la emisión con 422 " +
            "(\"Dirección no puede estar vacío\" / \"Ciudad no puede estar vacío\") cuando el cliente " +
            "se da de alta en la misma llamada. Si el cliente YA existe en Biller con dirección " +
            "cargada, alcanza con enviar el documento.",
        );
      }
    }
  }

  // Ítems sin indicador de facturación: el IVA queda a criterio de Biller.
  if (tipo !== TIPO_RESGUARDO && !TIPOS_REMITO.has(tipo)) {
    const sinIndicador = items.filter((i) => i.indicador_facturacion === undefined).length;
    if (sinIndicador > 0) {
      warnings.push(
        `${sinIndicador} ítem(s) sin 'indicador_facturacion': define el tratamiento de IVA ante DGI ` +
          "(3 = tasa básica 22%, 2 = tasa mínima 10%, 1 = exento).",
      );
    }
  }

  // Venta por cuenta ajena sin mandante.
  if ([131, 132, 133, 141, 142, 143].includes(tipo) && body.complementoFiscal === undefined) {
    warnings.push(
      `El comprobante ${tipo} (${etiqueta}) es de venta por cuenta ajena: normalmente requiere ` +
        "'complementoFiscal' con los datos del mandante.",
    );
  }

  // Descuentos globales que no matchean el indicador de ningún ítem.
  for (const dr of body.descuentosRecargos ?? []) {
    const match = items.some((i) => i.indicador_facturacion === dr.indicador_facturacion);
    if (!match && items.length > 0) {
      warnings.push(
        `El descuento/recargo global "${dr.glosa ?? ""}" usa indicador_facturacion ${dr.indicador_facturacion}, ` +
          "que no coincide con el de ningún ítem: no afectará a nada.",
      );
    }
  }

  if (body.numero_interno === undefined) {
    warnings.push(
      "Sin 'numero_interno' no hay forma de deduplicar la emisión: si la llamada se reintenta, " +
        "se puede emitir el CFE dos veces. Recomendado enviarlo siempre.",
    );
  }

  // `montos_brutos` ausente NO es neutral, y es el campo que más plata mueve.
  //
  // La API interpreta el silencio como "los precios son netos" y le suma el
  // 22%. O sea que omitirlo YA ES una respuesta, y es la equivocada para el
  // precio de mostrador uruguayo, que se cotiza con IVA adentro: "la pelota,
  // $200" sale facturada $244 y el comprobante queda perfectamente bien
  // formado. Se avisa con el mismo criterio que la sucursal y el receptor: un
  // campo cuya ausencia cambia el documento tiene que verse en el preview.
  //
  // No aplica a remitos ni resguardos: ahí no hay precios que interpretar.
  if (tipo !== TIPO_RESGUARDO && !TIPOS_REMITO.has(tipo) && body.montos_brutos === undefined) {
    warnings.push(
      "Falta 'montos_brutos', y su ausencia NO es neutral: la API asume que los precios son " +
        "NETOS y les suma el IVA (22% en tasa básica). Si los precios que dio el usuario ya " +
        "incluían IVA —el precio de mostrador uruguayo—, este comprobante va a salir 22% más " +
        "caro. Mandá montos_brutos=true si ya lo incluían, o false para dejarlo explícito.",
    );
  }

  return warnings;
}
