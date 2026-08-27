# "Envío no corresponde": ¿cuenta o no cuenta en los totales?

- **Estado:** abierto
- **Tipo:** task
- **Asignado:** —
- **Bloqueado por:** —

## Question

Los e-Ticket por debajo de 5.000 UI no se envían de a uno a DGI: van en el
reporte diario, y quedan con `estado: "Envío no corresponde"`. Son comprobantes
válidos.

Pero **8 tools de análisis filtran por `estado === "Aceptado DGI"`** con
`solo_aceptados: true` por default: `resumen_facturacion_periodo`,
`vencimientos`, `cuenta_corriente`, `ranking_clientes`, `ranking_productos`,
`comparar_periodos`, `posicion_iva` y `plata_en_riesgo`.

Si el estado normal de un ticket chico es "Envío no corresponde", entonces **un
comercio que vende con tickets chicos tiene la mayor parte de sus ventas afuera
de todos sus reportes.** El número se ve bien, es coherente consigo mismo, y
está mal.

Contra eso hay un antecedente explícito del dueño: filtrar por "Aceptado DGI" es
lo que hacía que los números coincidieran con el dashboard de Biller. Las dos
cosas no pueden ser ciertas a la vez.

A resolver:

1. **Determinar qué muestra Biller.** Emitir en test un e-Ticket chico (queda en
   "Envío no corresponde") y comparar el total del período contra el dashboard
   de Biller. Si hace falta, preguntarle al dueño que mire la pantalla.
2. Según eso, corregir el criterio en las 8 tools — o dejarlo y **documentar por
   qué**, que hoy no está escrito en ningún lado.
3. Si el criterio cambia, revisar `docs/CALCULOS.md`, que declara la regla
   actual.

## Nota

Ya existe `src/services/estadoDgi.ts` con `esVentaValida()`, que incluye "Envío
no corresponde" como venta válida. **Todavía no lo usa ninguna de las 8 tools**:
se escribió para arreglar un aviso equivocado al mandar PDFs. Este ticket decide
si ese criterio se propaga o se revierte.
