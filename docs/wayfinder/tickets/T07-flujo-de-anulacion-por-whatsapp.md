# El flujo de anular, mensaje por mensaje

- **Estado:** abierto
- **Tipo:** prototype
- **Asignado:** —
- **Bloqueado por:** [Qué se puede anular, cómo, y qué pasa cuando no se puede](T02-reglas-de-anulacion.md)

## Avance implementado (2026-09-02)

El caso simple de anulación total ya tiene doble confirmación por WhatsApp:
paso 1 de revisión con token no ejecutable, paso 2 visualmente distinto con el
token final ligado al payload, y cancelación explícita. Un cambio de comprobante
entre ambos pasos invalida la revisión y el primer token no puede disparar el
POST. Siguen pendientes el selector de comprobante, el bloqueo comprobado por
cobro, el camino parcial y el PDF posterior; dependen del research de T02.

## Question

¿Cómo es la conversación completa para anular, desde "me equivoqué en una
factura" hasta la NC emitida?

Hoy existe `biller_plan_anulacion`, que **dice** qué hay que hacer pero no lo
hace, y `biller_anular_comprobante`, que ejecuta el caso simple. Falta la
conversación que los une, y sobre todo faltan los caminos que no son el feliz.

A definir, con las restricciones ya fijadas:

1. **Encontrar el comprobante.** El usuario no sabe el id. ¿Se ofrecen los
   últimos emitidos como lista tocable? ¿Se busca por monto, por cliente, por
   "la de ayer"?
2. **Total o parcial**, siempre como opciones para elegir — nunca preguntando
   un monto en texto libre.
3. **Si es parcial**, cómo se elige qué se acredita: ¿ítems de una lista?
   ¿monto? Depende de lo que habilite la API.
4. **La doble confirmación.** Tiene que ser distinta de la de emitir: si son dos
   mensajes iguales con botones verdes, la segunda se toca por inercia. ¿Qué la
   hace distinta sin volverla molesta?
5. **El caso bloqueado**: factura ya cobrada. Hay que explicar por qué no se
   puede y qué hacer en su lugar, sin dejar al usuario sin salida.
6. **El caso derivado**: cuando el endpoint simple no aplica y hay que armar la
   NC a mano, ¿lo hace el flujo o se manda a Biller?
7. Qué pasa **después**: ¿se ofrece el PDF de la NC, se avisa al cliente?

## Cómo se resuelve

Con `/prototype`: escribir la conversación entera para los tres casos —simple,
parcial, bloqueado por cobro— como si fueran capturas de pantalla, y recién
después decidir la implementación.
