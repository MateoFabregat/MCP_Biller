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
//
// ESTE ARCHIVO ES EL DUEÑO ÚNICO DE `clasificarEstado`
//
// Hasta agosto de 2026 había DOS funciones con ese nombre: esta y otra en
// `resumenFacturacion.ts` que devolvía `aceptado | no_aceptado | desconocido`.
// El resumen excluía solo lo que sabía rechazado y CONTABA el estado
// desconocido; los rankings, la comparación, las cohortes y la posición IVA
// filtraban con `!== "aceptado"` y lo EXCLUÍAN. Para los mismos comprobantes,
// dos totales distintos, y cambiar un import por el otro los movía sin que tsc
// dijera nada. Se unificó acá, que es la que tiene el razonamiento escrito.
// El criterio de qué suma en un total vive en `estaAceptado`, abajo.
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
 * EL criterio de estado de todo total de plata del proyecto (`solo_aceptados`):
 * cuenta los CFE fiscalmente válidos, tanto "Aceptado DGI" como "Envío no
 * corresponde". Este último se informa por reporte diario y no es un rechazo.
 *
 * Por qué tan estricto, incluido el estado DESCONOCIDO (`estado: null`, vacío,
 * o un texto que no reconocemos): el valor del asistente depende de que sus
 * números coincidan con los que el usuario ve en su panel de Biller, y Biller
 * arma sus totales con "Aceptado DGI". Un total conservador que cierra es mejor
 * que uno generoso que no. Contar lo desconocido —el criterio que tenía el
 * resumen hasta agosto de 2026, con el argumento de que "la ausencia del dato
 * no es evidencia de rechazo"— hacía que el resumen y los rankings contestaran
 * distinto para los mismos comprobantes.
 *
 * Ese argumento no era tonto y no se perdió: si el `estado` falta por un
 * problema de la API y no del comprobante, excluirlo baja el total sin motivo
 * visible. Por eso el criterio estricto SOLO es tolerable acompañado del aviso:
 * quien excluye por estado tiene que decir CUÁNTOS excluyó, y donde lo que se
 * responde es un monto —el resumen y lo cobrado— también CUÁNTO sumaban,
 * separando lo que sumaba de lo que restaba (una nota de crédito excluida no
 * deja el total corto: lo deja inflado). Ver el warning de `sinEstadoConocido`
 * en `resumenFacturacion.ts`, y los equivalentes en los rankings de clientes,
 * sucursales y productos, la comparación, las cohortes y la posición IVA: no
 * queda ningún camino de plata que excluya en silencio.
 *
 * COMPARA EXACTO, NO POR SUBSTRING. La implementación que había en
 * `resumenFacturacion.ts` usaba `/aceptado/i`, así que un hipotético
 * "Aceptado DGI (con observaciones)" contaba; con esta cuenta como desconocido
 * y no suma. No hay ninguna evidencia de que la API devuelva variantes —los
 * cinco estados observados están arriba—, y ante un texto que no conocemos
 * preferimos no afirmar que Biller lo está sumando. Pero el cambio no es
 * inocuo: `anulacion.ts`, `cuentaCorriente.ts` y `vencimientos.ts` piden esta
 * función y una variante así sería, en cuenta corriente, un recibo que deja de
 * imputarse y un cliente al que se le reclama plata que ya pagó. Si alguna vez
 * aparece una variante real, la decisión se toma acá y en un solo lugar. Lo
 * fija `tests/estadoDgi.test.ts`.
 *
 * MODO DE FALLA si alguien lo relaja: el total del resumen deja de coincidir
 * con el del ranking, nada falla, y nadie se entera hasta que un cliente lo
 * nota.
 */
export function estaAceptado(estado: string | null | undefined): boolean {
  const clase = clasificarEstado(estado);
  return clase === "aceptado" || clase === "no_corresponde_enviar";
}

/**
 * ¿Este comprobante es una venta válida que debería contar en los totales?
 *
 * Incluye "Envío no corresponde" a propósito: es una venta real y facturada.
 * Excluirla porque no fue enviada individualmente a DGI es confundir el canal
 * de reporte con la validez del documento.
 *
 * Se conserva como nombre semántico para callers que preguntan por validez;
 * comparte deliberadamente el mismo criterio que `estaAceptado`.
 */
export function esVentaValida(estado: string | null | undefined): boolean {
  return estaAceptado(estado);
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
