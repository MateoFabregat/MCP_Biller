# 03 — Exportación: qué indicador de facturación lleva

**Qué construir:** el camino completo de una venta al exterior. Está bloqueado
por UNA decisión fiscal que solo puede tomar el dueño.

**Severidad:** media (cara cuando pasa) · **Bloquea producción:** sí, para ese caso

## Dónde está parado

El flujo guiado produce e-Ticket (101) y e-Factura (111). Una venta a un cliente
del exterior hoy **se frena** (`sugiereExportacion`) en vez de emitirse mal.

El dueño ya definió el criterio: **es un e-Ticket con los datos externos del
cliente** — documento extranjero (pasaporte 5, DNI 6 o NIFE 7) y su país. El
schema ya acepta las dos cosas (`cliente.tipo_documento`,
`cliente.sucursal.pais`).

## Lo único que falta para codearlo

**¿Qué `indicador_facturacion` lleva cada línea?** El flujo asume 3 (tasa
básica, 22%), que para una venta al exterior no corresponde. Los candidatos de
la tabla son `10` ("Exportación y asimiladas") y `1` ("Exento"), y elegir mal
cambia el IVA del comprobante.

**No se implementa adivinando.** Con ese dato, el resto es corto:

1. Un paso más en el flujo cuando el receptor es del exterior: tipo de documento
   y país.
2. El indicador fijo para esas líneas.
3. Levantar el freno para ese camino, y dejarlo para todo lo demás.
