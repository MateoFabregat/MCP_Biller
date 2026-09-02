# Emisión endurecida: IVA incluido, numero_interno y los casos que hoy fallan

- **Estado:** abierto
- **Tipo:** task
- **Asignado:** —
- **Bloqueado por:** [Las reglas reales para que un 101 y un 111 salgan bien](T01-reglas-de-emision-validas.md)

## Avance implementado (2026-09-02)

Ya están cubiertos `montos_brutos` en el flujo/preview, `numero_interno`
automático, fechas reales, prechequeo de duplicado fail-closed, reserva atómica
antes del POST, estado ambiguo ante pérdida de respuesta y tope sobre
`pago.monto`. Falta el cierre real contra `test.biller.uy` con verificación del
PDF, la cotización obtenida de Biller y el diagnóstico temprano CAE/DGI.

## Question

Aplicar al flujo de emisión todo lo que salga del ticket de reglas, y cerrar los
huecos ya identificados:

1. **`montos_brutos`.** Preguntar siempre si el precio incluye IVA, y que la
   respuesta viaje al cuerpo del CFE. Es el hueco confirmado: en la prueba del
   28/07 un precio de 500 produjo un comprobante de 610 sin que nadie lo pidiera.
2. **`numero_interno` automático.** Es la única defensa contra emitir dos veces
   por un reintento, y hoy no se genera nunca. Definir formato —tiene que ser
   único y además rastreable por una persona— y generarlo siempre.
3. **Consumidor final sin identificar**: mandar el `cliente` con la forma que
   confirme el ticket de reglas.
4. **Fecha siempre hoy**: sacar la posibilidad de fecha pasada del flujo, que
   hoy la acepta como texto libre.
5. **Tasa de cambio**: si Biller la trae sola, usar esa y mostrarla.
6. **CAE agotado o DGI caído**: detectarlo **antes** de pedirle seis datos al
   usuario, y recomendar seguir en la interfaz de Biller.

## Criterio de cierre

Emisión real contra `test.biller.uy` de los cuatro casos: e-Ticket de mostrador
con IVA incluido, e-Ticket arriba del umbral de UI, e-Factura a cliente
existente, e-Factura a cliente nuevo. Los cuatro con el total correcto verificado
en el PDF, no solo un 201.
