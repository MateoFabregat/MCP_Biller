// =============================================================================
// ¿En qué moneda se ordena un ranking?
//
// La regla es una sola y estaba copiada CINCO veces (clientes, productos,
// sucursales, proveedores, cohortes), byte por byte. Cinco copias de una regla
// de negocio son cinco lugares donde puede evolucionar por separado — y si dos
// rankings de la misma conversación eligieran la moneda con criterios
// distintos, los números del usuario dejarían de cerrar entre pantallas sin que
// nada falle.
//
// LA REGLA: si el llamador pidió una moneda, esa. Si no, la de mayor
// facturación del período; y si no hay ninguna (período vacío), UYU, porque un
// resultado vacío también necesita decir en qué moneda está vacío.
// =============================================================================

/** Elige la moneda con la que se ordena y se calculan participaciones. */
export function monedaDeOrden(
  totalPorMoneda: Readonly<Record<string, number>>,
  monedaPedida: string | undefined,
): string {
  if (monedaPedida !== undefined) return monedaPedida;
  const presentes = Object.keys(totalPorMoneda);
  return presentes.reduce(
    (mejor, m) => ((totalPorMoneda[m] ?? 0) > (totalPorMoneda[mejor] ?? 0) ? m : mejor),
    presentes[0] ?? "UYU",
  );
}
