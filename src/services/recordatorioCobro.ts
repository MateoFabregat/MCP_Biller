// =============================================================================
// C6 / E5 — El recordatorio de cobro que se le manda AL CLIENTE DEUDOR.
//
// Es la funcionalidad más vendible del backlog y la más peligrosa, por una razón
// que no tiene nada que ver con el código: **el destinatario no es el usuario.**
// Todo lo demás que hace este server le contesta al dueño de la PyME, que
// conoce sus propios números y detecta un disparate. Esto le escribe a un
// tercero, con el nombre de la empresa adelante, y un mensaje entregado no se
// puede retirar. Un monto mal calculado no es un error de software: es una
// relación comercial quemada.
//
// De ahí las cuatro reglas que definen este módulo:
//
// 1. LOS NÚMEROS LOS ESCRIBE TYPESCRIPT, NO EL MODELO. El texto sale armado de
//    acá con los importes ya calculados. Si lo redactara el modelo, el monto del
//    mensaje y el de la cuenta corriente podrían no coincidir, y el que recibe
//    el WhatsApp no tiene forma de notarlo.
//
// 2. EL DETALLE POR FACTURA SOLO VA SI LA IMPUTACIÓN ES EXACTA. `cuentaCorriente`
//    declara su `estrategia`: cuando cae a FIFO, el saldo TOTAL del cliente
//    sigue siendo exacto pero CUÁL factura quedó impaga es una estimación.
//    Reclamar la factura equivocada es peor que no dar detalle, así que en ese
//    caso el mensaje dice el total y nada más. Esta es la regla que convierte el
//    caveat de `estrategia` en una decisión, en vez de una nota al pie.
//
// 3. NO SE RECLAMA LO QUE NO ESTÁ VENCIDO, salvo que se pida explícitamente.
//    Apurar una factura que todavía está en plazo es lo que hace que el próximo
//    recordatorio —el que sí corresponde— se lea como spam.
//
// 4. NUNCA SALE UN DATO DE OTRO CLIENTE. El mensaje se arma con los documentos
//    de UN rut. Es obvio y por eso hay un test que lo fija: el día que alguien
//    "mejore" esto pasándole la lista entera, el bug es una fuga de datos.
//
// La allowlist de destinatarios y el ciclo dry-run → token → confirm viven en la
// tool (`src/tools/recordatorioCobro.ts`). Acá solo se arma el contenido.
// =============================================================================

import { envolverEnLinea } from "../security/untrusted.js";
import { round2 } from "../biller/coerce.js";
import type {
  CuentaCorrienteResultado,
  DocumentoDeuda,
  SaldoCliente,
} from "./cuentaCorriente.js";
import { SIN_RECEPTOR } from "./rankingClientes.js";

/** Por qué un recordatorio NO se puede armar. Cada motivo tiene una salida distinta. */
export type MotivoNoEnviable =
  | "cliente_no_encontrado"
  | "sin_deuda"
  | "sin_documentos_vencidos"
  | "cliente_sin_identificar";

export interface LineaDeuda {
  /** "e-Factura A-1234" — lo que el cliente ve en su propio comprobante. */
  documento: string;
  fecha_vencimiento: string | null;
  /** Días de atraso. 0 o negativo = todavía no venció. */
  dias_atraso: number;
  moneda: string;
  saldo: number;
  /** true si ya se cobró una parte: el mensaje lo dice para que no haya sorpresa. */
  parcial: boolean;
}

export interface RecordatorioResultado {
  /** null si no hay nada que reclamar. `motivo` dice por qué. */
  mensaje: string | null;
  motivo: MotivoNoEnviable | null;
  /** Explicación en castellano de `motivo`, para devolverle al usuario. */
  explicacion: string | null;
  cliente_rut: string | null;
  cliente_nombre: string | null;
  /** Saldo reclamado, por moneda. Nunca se suman monedas distintas. */
  total_reclamado_por_moneda: Record<string, number>;
  /** Documentos incluidos en el mensaje. Vacío cuando la imputación no es exacta. */
  lineas: LineaDeuda[];
  /** Cuántos documentos entraron en el total (aunque no se detallen). */
  documentos: number;
  /** true si el detalle por factura se omitió por imputación estimada. */
  detalle_omitido_por_imputacion: boolean;
  dias_atraso_maximo: number;
  warnings: string[];
}

export interface RecordatorioOptions {
  /** Nombre de la empresa que reclama. Va en la firma del mensaje. */
  empresa?: string;
  /** Incluir también lo que todavía no venció. Default false. */
  incluir_por_vencer?: boolean;
  /** Línea libre del usuario, que va ARRIBA de los números. */
  nota?: string;
  /** Máximo de facturas a listar. Default 10: un mensaje de WhatsApp, no un extracto. */
  max_lineas?: number;
}

/** Importe con separadores locales. Determinístico: no lo escribe el modelo. */
export function formatearImporte(moneda: string, monto: number): string {
  const n = new Intl.NumberFormat("es-UY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(monto);
  return `${moneda} ${n}`;
}

/** "e-Factura A-1234", o el id si falta serie/número. */
function nombrarDocumento(d: DocumentoDeuda): string {
  const partes = [d.serie, d.numero === null ? null : String(d.numero)].filter(
    (p): p is string => p !== null && p !== "",
  );
  const identificacion = partes.length > 0 ? partes.join("-") : `#${d.id ?? "?"}`;
  return `${d.etiqueta_tipo} ${identificacion}`;
}

/**
 * Arma el recordatorio de cobro de UN cliente.
 *
 * `cuenta` tiene que venir del mismo período que se le va a mostrar al usuario
 * en el preview: el token de confirmación liga el envío al texto exacto, y ese
 * texto es el que sale de acá.
 */
export function construirRecordatorio(
  cuenta: CuentaCorrienteResultado,
  rut: string,
  opciones: RecordatorioOptions = {},
): RecordatorioResultado {
  const incluirPorVencer = opciones.incluir_por_vencer ?? false;
  const maxLineas = opciones.max_lineas ?? 10;
  const warnings: string[] = [];

  const vacio = (
    motivo: MotivoNoEnviable,
    explicacion: string,
    cliente: SaldoCliente | null = null,
  ): RecordatorioResultado => ({
    mensaje: null,
    motivo,
    explicacion,
    cliente_rut: cliente?.cliente_rut ?? null,
    cliente_nombre: cliente?.cliente_nombre ?? null,
    total_reclamado_por_moneda: {},
    lineas: [],
    documentos: 0,
    detalle_omitido_por_imputacion: false,
    dias_atraso_maximo: 0,
    warnings,
  });

  if (rut.trim() === "" || rut === SIN_RECEPTOR) {
    return vacio(
      "cliente_sin_identificar",
      "No se puede mandar un recordatorio al grupo de ventas sin receptor: agrupa comprobantes de " +
        "personas distintas. Solo se le reclama a un cliente con RUT/CI identificado.",
    );
  }

  const cliente = cuenta.por_cliente.find((c) => c.cliente_rut === rut) ?? null;
  if (cliente === null) {
    return vacio(
      "cliente_no_encontrado",
      `El cliente ${rut} no aparece en la cuenta corriente del período consultado. Puede no tener ` +
        "movimientos ahí: ampliá el período antes de concluir que no debe nada.",
    );
  }

  const saldoTotal = Object.values(cliente.saldo_por_moneda).reduce((a, m) => a + m.total, 0);
  if (saldoTotal <= 0) {
    return vacio(
      "sin_deuda",
      `${envolverEnLinea(cliente.cliente_nombre, rut)} no tiene saldo pendiente en el período consultado. No hay ` +
        "nada que reclamar — mandar un recordatorio igual es la forma más rápida de que el próximo " +
        "se ignore.",
      cliente,
    );
  }

  // --- Documentos de ESTE cliente, y de ningún otro -------------------------
  const suyos = cuenta.documentos.filter((d) => d.cliente_rut === rut && d.saldo > 0);
  const reclamables = incluirPorVencer
    ? suyos
    : suyos.filter((d) => d.dias_para_vencer !== null && d.dias_para_vencer < 0);

  if (reclamables.length === 0) {
    return vacio(
      "sin_documentos_vencidos",
      `${envolverEnLinea(cliente.cliente_nombre, rut)} tiene saldo pendiente pero nada vencido todavía. Apurar una ` +
        "factura que está en plazo es lo que hace que el recordatorio que sí corresponde se lea " +
        "como spam. Si igual querés mandarlo, pedilo con incluir_por_vencer.",
      cliente,
    );
  }

  // Más vencido primero: es el orden en el que se cobra.
  reclamables.sort((a, b) => (a.dias_para_vencer ?? 0) - (b.dias_para_vencer ?? 0));

  const totalPorMoneda: Record<string, number> = {};
  for (const d of reclamables) {
    totalPorMoneda[d.moneda] = round2((totalPorMoneda[d.moneda] ?? 0) + d.saldo);
  }
  const atrasoMaximo = Math.max(
    0,
    ...reclamables.map((d) => (d.dias_para_vencer === null ? 0 : -d.dias_para_vencer)),
  );

  // --- Regla 2: el detalle solo si la imputación es exacta ------------------
  const detalleOmitido = !cuenta.imputacion_exacta;
  const lineas: LineaDeuda[] = detalleOmitido
    ? []
    : reclamables.slice(0, maxLineas).map((d) => ({
        documento: nombrarDocumento(d),
        fecha_vencimiento: d.fecha_vencimiento,
        dias_atraso: d.dias_para_vencer === null ? 0 : -d.dias_para_vencer,
        moneda: d.moneda,
        saldo: d.saldo,
        parcial: d.estado_cobro === "parcial",
      }));

  if (detalleOmitido) {
    warnings.push(
      `La imputación de cobros de este período es "${cuenta.estrategia}", o sea que cuál factura ` +
        "puntual quedó impaga es una ESTIMACIÓN. El mensaje reclama el total del cliente sin " +
        "detallar comprobantes: reclamar la factura equivocada es peor que no dar detalle.",
    );
  }
  if (!detalleOmitido && reclamables.length > maxLineas) {
    warnings.push(
      `El cliente tiene ${reclamables.length} documentos vencidos y el mensaje detalla los ` +
        `${maxLineas} más viejos. El total reclamado incluye a TODOS.`,
    );
  }
  if (Object.keys(totalPorMoneda).length > 1) {
    warnings.push(
      "La deuda está en más de una moneda. El mensaje las lista por separado y NO las suma: un " +
        "total mezclado no significa nada y encima no se puede pagar.",
    );
  }

  // --- El texto -------------------------------------------------------------
  const lineasTexto: string[] = [];
  if (opciones.nota !== undefined && opciones.nota.trim() !== "") {
    lineasTexto.push(opciones.nota.trim(), "");
  }

  // El nombre lo escribió un tercero y este mensaje lo lee el modelo antes de
  // que una persona lo apruebe. Va marcado; la marca se cae en `KapsoClient`,
  // que es la única puerta hacia un teléfono, así que el cliente recibe
  // "Hola Ferretería López," y el modelo lee el nombre etiquetado como dato.
  const saludo =
    cliente.cliente_nombre === null ? "Hola," : `Hola ${envolverEnLinea(cliente.cliente_nombre)},`;
  lineasTexto.push(saludo, "");
  lineasTexto.push(
    reclamables.length === 1
      ? "Te escribimos por un comprobante pendiente de pago:"
      : `Te escribimos por ${reclamables.length} comprobantes pendientes de pago:`,
  );
  lineasTexto.push("");

  if (lineas.length > 0) {
    for (const l of lineas) {
      const atraso =
        l.dias_atraso > 0
          ? ` · vencida hace ${l.dias_atraso} día${l.dias_atraso === 1 ? "" : "s"}`
          : l.fecha_vencimiento === null
            ? ""
            : ` · vence el ${l.fecha_vencimiento}`;
      const parcial = l.parcial ? " (saldo, ya con el pago parcial descontado)" : "";
      lineasTexto.push(`• ${l.documento}: ${formatearImporte(l.moneda, l.saldo)}${atraso}${parcial}`);
    }
    lineasTexto.push("");
  }

  for (const [moneda, monto] of Object.entries(totalPorMoneda)) {
    lineasTexto.push(`Total: ${formatearImporte(moneda, monto)}`);
  }

  lineasTexto.push("");
  lineasTexto.push(
    "Si ya lo abonaste, avisanos y lo damos por cancelado — puede haber cruzado con este mensaje.",
  );
  if (opciones.empresa !== undefined && opciones.empresa.trim() !== "") {
    lineasTexto.push("", `Gracias, ${opciones.empresa.trim()}`);
  }

  return {
    mensaje: lineasTexto.join("\n"),
    motivo: null,
    explicacion: null,
    cliente_rut: cliente.cliente_rut,
    cliente_nombre: cliente.cliente_nombre,
    total_reclamado_por_moneda: totalPorMoneda,
    lineas,
    documentos: reclamables.length,
    detalle_omitido_por_imputacion: detalleOmitido,
    dias_atraso_maximo: atrasoMaximo,
    warnings,
  };
}
