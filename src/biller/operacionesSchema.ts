// =============================================================================
// Schemas tipados de las operaciones de escritura que NO son emisión de CFE:
// recibos, pagos, clientes y productos.
//
// A diferencia de POST /v3/comprobantes/emitir (que solo trae ejemplos), estos
// endpoints SÍ declaran un JSON Schema con `required` en la doc de Biller. Cada
// campo obligatorio de acá sale de ese `required`, no de una interpretación.
//
// Ojo con las fechas: conviven DOS formatos en la misma API.
//   - `fecha_emision` / `fecha_vencimiento` de un CFE  -> dd/mm/aaaa
//   - fechas de recibos y pagos                        -> aaaa-mm-dd (ISO)
//   - `pagos.fecha`                                    -> admite ambos
// Cada schema valida el que le corresponde y lo dice en el mensaje de error.
// =============================================================================

import { z } from "zod";
import {
  INDICADORES_FACTURACION,
  TIPOS_COMPROBANTE,
  TIPOS_DOCUMENTO,
  parseFechaDgi,
} from "./cfeSchema.js";
import { booleano, codigo, entero, fechaIso, numero, round2, texto } from "./coerce.js";

// ---------------------------------------------------------------------------
// Recibos — POST /v2/recibos/crear
// required: ["cliente", "sucursal", "moneda", "pago"]
// ---------------------------------------------------------------------------

/** Receptor del recibo. required: ["tipo_documento", "documento"]. */
export const ClienteReciboSchema = z
  .object({
    tipo_documento: codigo(TIPOS_DOCUMENTO, "cliente.tipo_documento"),
    documento: z.string().min(1, "cliente.documento es obligatorio.").describe("Sin puntos ni guiones."),
    razon_social: texto(70, "cliente.razon_social")
      .optional()
      .describe("Nombre principal para tipo_documento 2 (RUT) y 7 (NIFE)."),
    nombre_fantasia: texto(30, "cliente.nombre_fantasia")
      .optional()
      .describe("Nombre principal para tipo_documento 3 (CI), 5 (Pasaporte) y 6 (DNI)."),
    sucursal: z
      .object({
        direccion: texto(70, "cliente.sucursal.direccion").optional(),
        ciudad: texto(30, "cliente.sucursal.ciudad").optional(),
        departamento: texto(30, "cliente.sucursal.departamento").optional(),
        pais: z.string().optional().describe("Código ISO 3166-1 alpha-2, ej: UY."),
      })
      .passthrough()
      .optional()
      .describe("Dirección del cliente."),
  })
  .passthrough();

/** Referencia de recibo: `padre` es el ID del CFE que se está cobrando. */
export const ReferenciaReciboSchema = z
  .object({
    padre: entero("referencias.padre").describe("ID en Biller del comprobante que se quiere pagar."),
    total: numero("referencias.total").describe("Monto imputado a ese comprobante."),
  })
  .passthrough();

/** Información del pago. required: ["fecha", "monto"]. */
export const PagoReciboSchema = z
  .object({
    fecha: fechaIso("pago.fecha"),
    monto: numero("pago.monto").describe("Debe ser mayor o igual al total de las referencias."),
    referencia: z
      .string()
      .optional()
      .describe('Identifica el PAGO, no el comprobante. Ej: "Transferencia Itaú 2185".'),
  })
  .passthrough();

export const ReciboBodySchema = z
  .object({
    tipo_comprobante: codigo(TIPOS_COMPROBANTE, "tipo_comprobante")
      .optional()
      .describe("Tipo de CFE del recibo. Ej: 101 e-Ticket, 111 e-Factura."),
    forma_pago: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = Contado, 2 = Crédito."),
    fecha_emision: fechaIso("fecha_emision")
      .optional()
      .describe("aaaa-mm-dd. Si se omite, Biller usa la fecha actual."),
    fecha_vencimiento: fechaIso("fecha_vencimiento")
      .nullable()
      .optional()
      .describe("aaaa-mm-dd o null."),
    // Obligatoria para Biller, pero opcional acá para que pueda completarse con
    // BILLER_DEFAULT_SUCURSAL_ID. Si sigue faltando, la tool bloquea la ejecución.
    sucursal: entero("sucursal")
      .optional()
      .describe("ID de la sucursal emisora (Ajustes → Sucursales). Obligatoria para Biller."),
    moneda: z.string().min(1, "moneda es obligatoria.").describe("UYU, USD, ..."),
    montos_brutos: booleano()
      .optional()
      .describe("Si los montos de las referencias incluyen impuestos."),
    tasa_cambio: numero("tasa_cambio").optional().describe("Requerida cuando la moneda no es UYU."),
    cliente: ClienteReciboSchema.describe(
      "Obligatorio: sin receptor, Biller responde 422 'cliente required'.",
    ),
    referencias: z
      .array(ReferenciaReciboSchema)
      .optional()
      .describe("Comprobantes que se están pagando. Se omite para un adelanto."),
    pago: PagoReciboSchema.describe("Obligatorio."),
    adenda: z.string().optional(),
    informacion_adicional: z.string().optional(),
    emails_notificacion: z.array(z.string().email("Email inválido en emails_notificacion")).optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    // "Monto total del pago. Debe ser mayor o igual al total de las referencias."
    const suma = (body.referencias ?? []).reduce((acc, r) => acc + r.total, 0);
    if (suma - body.pago.monto > 0.005) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `El monto del pago (${body.pago.monto}) es menor que el total de las referencias ` +
          `(${round2(suma)}). La doc exige que sea mayor o igual.`,
        path: ["pago", "monto"],
      });
    }
  });

export type ReciboBody = z.infer<typeof ReciboBodySchema>;

/** Avisos no bloqueantes del recibo (comportamiento documentado, no errores). */
export function validarRecibo(body: ReciboBody): string[] {
  const warnings: string[] = [];
  const referencias = body.referencias ?? [];
  const suma = round2(referencias.reduce((acc, r) => acc + r.total, 0));
  const monto = body.pago.monto;

  if (referencias.length === 0) {
    warnings.push(
      'El recibo no referencia ningún comprobante: Biller lo registrará como "Adelanto" por el monto total.',
    );
  } else if (monto > suma) {
    warnings.push(
      `El pago (${monto}) supera la suma de las referencias (${suma}). ` +
        `Biller agregará un ítem de "Adelanto" por la diferencia de ${round2(monto - suma)}.`,
    );
  }

  if (body.sucursal === undefined) {
    warnings.push(
      "Falta 'sucursal': Biller la exige. Pasala en el cuerpo o configurá BILLER_DEFAULT_SUCURSAL_ID.",
    );
  }

  if (body.moneda.toUpperCase() !== "UYU" && body.tasa_cambio === undefined) {
    warnings.push(
      `La moneda es ${body.moneda} y no se envió 'tasa_cambio', que la doc marca como requerida ` +
        "cuando la moneda no es UYU.",
    );
  }

  const suc = body.cliente.sucursal as Record<string, unknown> | undefined;
  if (suc === undefined || !suc.direccion) {
    warnings.push(
      "El receptor del recibo no trae dirección ('cliente.sucursal.direccion'); la doc la pide.",
    );
  }

  const td = body.cliente.tipo_documento;
  if ((td === 2 || td === 7) && !body.cliente.razon_social) {
    warnings.push("Para tipo_documento 2 (RUT) o 7 (NIFE) el nombre principal es 'razon_social', y no vino.");
  }
  if ((td === 3 || td === 5 || td === 6) && !body.cliente.nombre_fantasia) {
    warnings.push(
      "Para tipo_documento 3 (CI), 5 (Pasaporte) o 6 (DNI) el nombre principal es 'nombre_fantasia', y no vino.",
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Pagos — POST /v2/pagos/crear
// required: ["fecha", "monto", "referencia", "comprobantes"]
// ---------------------------------------------------------------------------

/** `fecha` de un pago admite aaaa-mm-dd o dd/mm/aaaa (único campo que acepta ambos). */
const fechaPago = z.string().superRefine((value, ctx) => {
  const t = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    if (Number.isNaN(Date.parse(t))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha debe ser una fecha real." });
    }
    return;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) {
    if (parseFechaDgi(t) === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha debe ser una fecha real." });
    }
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'fecha debe estar en formato aaaa-mm-dd o dd/mm/aaaa (ej: "2026-05-28" o "28/05/2026").',
  });
});

export const ComprobantePagoSchema = z
  .object({
    id: entero("comprobantes.id").describe("ID en Biller del comprobante al que se asigna el pago."),
    monto: numero("comprobantes.monto").describe("No puede superar el saldo pendiente del comprobante."),
  })
  .passthrough();

export const PagoBodySchema = z
  .object({
    fecha: fechaPago,
    monto: numero("monto").describe("Puede ser negativo para revertir un pago anterior."),
    referencia: texto(255, "referencia").describe("Obligatorio: información para identificar el pago."),
    comprobantes: z
      .array(ComprobantePagoSchema)
      .min(1, "Un pago debe imputarse a al menos un comprobante."),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    // "El monto total del pago debe coincidir con la suma de los montos asociados."
    const suma = body.comprobantes.reduce((acc, c) => acc + c.monto, 0);
    if (Math.abs(suma - body.monto) > 0.005) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `El monto del pago (${body.monto}) no coincide con la suma de los comprobantes (${round2(suma)}). ` +
          "La doc exige que coincidan.",
        path: ["monto"],
      });
    }
  });

export type PagoBody = z.infer<typeof PagoBodySchema>;

// ---------------------------------------------------------------------------
// Clientes — POST /v2/clientes/crear
// required: ["tipo_documento", "documento", "pais"]
//
// Los campos van en un ÚNICO objeto PLANO, no anidados como en la emisión.
// ---------------------------------------------------------------------------

export const ClienteCrearSchema = z
  .object({
    tipo_documento: codigo(TIPOS_DOCUMENTO, "tipo_documento"),
    documento: z.string().min(1, "documento es obligatorio.").describe("Sin puntos ni guiones."),
    pais: z.string().min(1, "pais es obligatorio.").describe("Código ISO 3166-1 alpha-2, ej: UY."),
    razon_social: texto(70, "razon_social")
      .optional()
      .describe("Nombre principal para tipo_documento 2 (RUT) y 7 (NIFE)."),
    nombre_fantasia: texto(30, "nombre_fantasia")
      .optional()
      .describe("Nombre principal para tipo_documento 3 (CI), 5 (Pasaporte) y 6 (DNI)."),
    informacion_adicional: texto(150, "informacion_adicional").optional(),
    direccion: texto(70, "direccion").optional(),
    ciudad: texto(30, "ciudad").optional(),
    departamento: texto(30, "departamento").optional(),
    emails: z.array(z.string().email("Email inválido en emails")).optional(),
  })
  .passthrough();

export type ClienteCrear = z.infer<typeof ClienteCrearSchema>;

/**
 * Avisos del cliente. El nombre principal NO es un campo `required` del schema
 * (solo tipo_documento, documento y pais lo son), así que se avisa en vez de
 * bloquear: la doc solo dice cuál campo cumple ese rol según el documento.
 */
export function validarClienteCrear(body: ClienteCrear): string[] {
  const warnings: string[] = [];
  const td = body.tipo_documento;

  if ((td === 2 || td === 7) && !body.razon_social) {
    warnings.push(
      "Para tipo_documento 2 (RUT) o 7 (NIFE) el nombre principal es 'razon_social', y no vino.",
    );
  }
  if ((td === 3 || td === 5 || td === 6) && !body.nombre_fantasia) {
    warnings.push(
      "Para tipo_documento 3 (CI), 5 (Pasaporte) o 6 (DNI) el nombre principal es 'nombre_fantasia', y no vino.",
    );
  }
  if (!body.razon_social && !body.nombre_fantasia) {
    warnings.push("El cliente no tiene ni 'razon_social' ni 'nombre_fantasia': quedará sin nombre.");
  }
  if (!body.direccion) {
    warnings.push(
      "El cliente no incluye 'direccion': Biller la necesita para emitirle comprobantes con receptor.",
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Productos — POST /v2/productos/cargar
// required: ["codigo", "nombre", "precio", "moneda", "indicador_facturacion", "es_servicio"]
// ---------------------------------------------------------------------------

export const ProductoSchema = z
  .object({
    codigo: texto(35, "codigo").describe('Código del producto, ej: "PROD-001".'),
    nombre: texto(80, "nombre"),
    precio: numero("precio").describe("Precio unitario con hasta 6 decimales."),
    moneda: z.string().min(1, "moneda es obligatoria.").describe("UYU, USD, ..."),
    indicador_facturacion: codigo(INDICADORES_FACTURACION, "indicador_facturacion"),
    es_servicio: booleano().describe("true = servicio (sin stock); false = producto (con stock)."),
    descripcion: z.string().optional(),
    unidad_medida: texto(4, "unidad_medida").optional().describe('Ej: "UNI".'),
    impuesto_tasa: numero("impuesto_tasa")
      .optional()
      .describe("Obligatorio cuando indicador_facturacion es 4 (Otra tasa)."),
    inventario: numero("inventario")
      .optional()
      .describe("Stock existente. Sobreescribe el valor si el producto ya existe."),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    // "Obligatorio cuando `indicador_facturacion` es 4 (Otra tasa)."
    if (body.indicador_facturacion === 4 && body.impuesto_tasa === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "'impuesto_tasa' es obligatorio cuando indicador_facturacion es 4 (Otra tasa): " +
          "sin la tasa, Biller no puede calcular el IVA.",
        path: ["impuesto_tasa"],
      });
    }
  });

export type Producto = z.infer<typeof ProductoSchema>;

/** Avisos del producto (la doc describe el comportamiento, no lo prohíbe). */
export function validarProducto(body: Producto): string[] {
  const warnings: string[] = [];
  if (body.es_servicio === true && body.inventario !== undefined) {
    warnings.push(
      "El ítem es un servicio (es_servicio=true) pero trae 'inventario': los servicios no usan stock, " +
        "así que Biller lo va a ignorar.",
    );
  }
  return warnings;
}
