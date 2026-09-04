# 01 — Pedirle a Biller un endpoint de validación (dry-run)

**Qué construir:** nada en este repo. Es un pedido al backend de Biller, y es el
de mayor palanca de toda la lista.

**Severidad:** alta (elimina una clase entera de riesgo) · **Bloquea producción:** no

## El problema

`POST /v3/comprobantes/emitir` **emite**. No hay forma de preguntarle a Biller
"¿este cuerpo es válido y cuánto da?" sin que salga un CFE real ante DGI. Por
eso este MCP recalcula localmente los totales, el IVA por tasa y el umbral de
las 5.000 UI: para poder mostrar un preview antes de que el documento exista.

Son ~760 líneas (`services/calcularTotales.ts`) que duplican una regla fiscal
que Biller ya implementa. La divergencia entre las dos es silenciosa: nosotros
mostramos un total y Biller emite otro.

## Qué pedir, concretamente

`POST /v3/comprobantes/validar` con el MISMO cuerpo que `emitir`, que devuelva:

- si el cuerpo es válido y, si no, qué campo falta (los mismos 422 de hoy);
- los totales calculados por Biller: subtotal, IVA por tasa, total;
- si el receptor es obligatorio para ese importe (el umbral en UI, que hoy
  configuramos a mano con `BILLER_VALOR_UI`).

Con eso se puede borrar el cálculo local o dejarlo solo como contraste.

## Cómo se sabe que sirvió

`npm run contrato` compara hoy nuestro cálculo contra lo que Biller devuelve al
emitir en TEST. Con un endpoint de validación esa comparación deja de necesitar
emitir, y puede correr en CI en cada cambio.
