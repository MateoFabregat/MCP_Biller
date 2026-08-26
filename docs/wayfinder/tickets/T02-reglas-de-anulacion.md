# Qué se puede anular, cómo, y qué pasa cuando no se puede

- **Estado:** abierto
- **Tipo:** research
- **Asignado:** —
- **Bloqueado por:** —

## Question

¿Cuáles son las reglas reales de anulación con notas de crédito (102 para
e-Ticket, 112 para e-Factura), incluyendo todos los casos donde el camino fácil
NO sirve?

El OpenAPI dice algo que cambia el diseño entero:

> `POST /v2/comprobantes/anular` permite anular e-Tickets y e-Facturas **que no
> tengan comprobantes asociados**, creando una NC que anula el CFE en su
> totalidad.

O sea que el endpoint cómodo cubre solo el caso limpio. Todo lo demás —una
factura que ya tiene una nota, una que ya fue cobrada, una anulación parcial—
hay que armarlo a mano como NC vía `POST /v3/comprobantes/emitir` con
`referencias`.

A cerrar, verificando cada uno contra `test.biller.uy`:

1. ¿Qué cuenta como "comprobante asociado"? ¿Un recibo que imputa esa factura la
   deja fuera del endpoint de anulación?
2. ¿Qué error devuelve exactamente cuando no corresponde? Hace falta poder
   distinguirlo para explicarlo en castellano y no mostrar un 422 crudo.
3. La NC manual: forma mínima del cuerpo. `referencias` acepta tres formatos
   (id de Biller, tipo+serie+numero, o + fecha para externos) — ¿cuál conviene?
4. **Anulación parcial**: ¿se hace con una NC de menos ítems, de menos monto, o
   con `descuentosRecargos`? ¿Biller valida que no exceda el original?
5. ¿Se puede anular dos veces la misma factura? ¿La API lo frena o lo permite y
   deja al cliente con saldo a favor?
6. `fecha_emision_hoy`: ¿qué implica fiscalmente elegir cada opción?
7. ¿La NC hereda el cliente y la sucursal del original, o hay que repetirlos?

## Por qué este ticket importa más que los otros

Anular es la operación que el usuario marcó como crítica, y es la única donde
equivocarse genera un segundo documento fiscal equivocado. Un error de emisión
se arregla anulando; un error de anulación deja dos comprobantes rotos.

## Entregable

Documento de referencia con el árbol de decisión completo —dado un comprobante,
qué camino de anulación corresponde y por qué— con la evidencia de cada caso
probado de verdad.
