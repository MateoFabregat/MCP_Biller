# 07 — Catálogo único de tipos de CFE

**Qué construir:** que la tabla de tipos de comprobante viva en un solo lugar.
Viene escrito de la ola C y quedó sin ejecutar.

**Severidad:** baja (deuda) · **Bloquea producción:** no

## El problema

`TIPOS_COMPROBANTE`, `TIPOS_EXPORTACION`, `TIPOS_REMITO`, `TIPOS_SIN_RETENCIONES`
y las clasificaciones de `cfeTypes.ts` describen el mismo universo desde lugares
distintos. Agregar un tipo obliga a acordarse de todos.

Es la misma clase de bug que la ola C ya arregló con las tasas de IVA (issue 06):
dos tablas que hay que editar juntas terminan diciendo cosas distintas.
