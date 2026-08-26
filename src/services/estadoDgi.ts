// =============================================================================
// Qué significa cada `estado` de un CFE — y por qué "no aceptado" no es lo
// mismo que "está mal".
//
// EL CASO QUE OBLIGÓ A ESCRIBIR ESTO
//
// Se emitió un e-Ticket de UYU 610 en test, volvió 201, y el `estado` quedó en
// "Envío no corresponde". El código de entonces trataba cualquier estado que no
// fuera "Aceptado DGI" como un problema, así que al mandar el PDF avisaba que
// "un CFE que DGI no aceptó no sirve como respaldo fiscal". Eso es FALSO acá y
// además asusta: el comprobante es perfectamente válido.
//
// "Envío no corresponde" quiere decir que ese CFE **no corresponde enviarlo
// individualmente** a DGI. Los e-Ticket por debajo del umbral de 5.000 UI
// (~$30.000) no se reportan de a uno: van en el reporte diario. El comprobante
// existe, es válido y tiene su firma; simplemente no viaja solo.
//
// Confundir eso con un rechazo tiene dos costos distintos:
//   - Al usuario se le dice que su factura no sirve, y sí sirve.
//   - Al filtrar totales por "Aceptado DGI", un comercio que vende con tickets
//     chicos se queda sin la mayor parte de sus ventas. Ver `esVentaValida`.
// =============================================================================

/** Estados observados de verdad en la API. NO existe "Anulado". */
export const ESTADO_ACEPTADO = "Aceptado DGI";
export const ESTADO_ENVIO_NO_CORRESPONDE = "Envío no corresponde";

export type ClaseEstado =
  /** DGI lo aceptó explícitamente. */
  | "aceptado"
  /** Válido, pero no se envía de a uno (e-Ticket bajo el umbral). */
  | "no_corresponde_enviar"
  /** Todavía sin respuesta de DGI. */
  | "pendiente"
  /** DGI lo rechazó: NO tiene validez fiscal. */
  | "rechazado"
  /** Un estado que no conocemos. Se trata como desconocido, no como bueno. */
  | "desconocido";

/** Normaliza para comparar: la API devuelve el texto tal cual, con tildes. */
function norm(estado: string): string {
  return estado
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function clasificarEstado(estado: string | null | undefined): ClaseEstado {
  if (estado === null || estado === undefined || estado.trim() === "") return "desconocido";
  const e = norm(estado);
  if (e === norm(ESTADO_ACEPTADO)) return "aceptado";
  if (e === norm(ESTADO_ENVIO_NO_CORRESPONDE)) return "no_corresponde_enviar";
  if (e.includes("rechazado")) return "rechazado";
  if (e.includes("pendiente")) return "pendiente";
  return "desconocido";
}

/**
 * ¿Este comprobante es una venta válida que debería contar en los totales?
 *
 * Incluye "Envío no corresponde" a propósito: es una venta real y facturada.
 * Excluirla porque no fue enviada individualmente a DGI es confundir el canal
 * de reporte con la validez del documento.
 *
 * OJO: esto NO es lo mismo que el filtro `solo_aceptados` que usan hoy las
 * tools de análisis, que compara contra "Aceptado DGI" a secas. Ver el aviso
 * de `advertenciaSiHayNoCorresponde`.
 */
export function esVentaValida(estado: string | null | undefined): boolean {
  const clase = clasificarEstado(estado);
  return clase === "aceptado" || clase === "no_corresponde_enviar";
}

/**
 * Qué avisarle al usuario sobre el estado de un comprobante que se le está
 * mandando. `null` = no hay nada que avisar.
 */
export function advertenciaDeEstado(estado: string | null | undefined): string | null {
  switch (clasificarEstado(estado)) {
    case "aceptado":
      return null;
    case "no_corresponde_enviar":
      // Se explica en vez de callarse: el usuario ve ese texto en el PDF y en
      // Biller, y sin explicación parece un error.
      return (
        `El estado dice "${estado}", que NO es un rechazo: los e-Ticket por debajo de 5.000 UI ` +
        "no se envían de a uno a DGI, se informan en el reporte diario. El comprobante es válido."
      );
    case "pendiente":
      return (
        `El comprobante está en estado "${estado}": DGI todavía no respondió. Es normal recién ` +
        "emitido; si queda así mucho tiempo, revisalo."
      );
    case "rechazado":
      return (
        `⚠️ El comprobante está en estado "${estado}": DGI lo RECHAZÓ, así que no tiene validez ` +
        "fiscal y no sirve como respaldo para quien lo recibe. Hay que revisarlo y volver a emitir."
      );
    case "desconocido":
      return (
        `El comprobante está en un estado que no reconozco ("${estado}"). No puedo afirmar que ` +
        "tenga validez fiscal: verificalo en Biller antes de usarlo como respaldo."
      );
  }
}
