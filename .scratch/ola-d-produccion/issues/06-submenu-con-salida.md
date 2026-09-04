# 06 — Todo submenú con salida de un toque

**Qué construir:** que ningún mensaje tocable deje al usuario sin forma de salir.
Viene escrito de la ola C y quedó sin ejecutar.

**Severidad:** alta (UX) · **Bloquea producción:** sí

## El problema

Varios submenús ofrecen las opciones del paso y ninguna manera de abandonar. El
usuario que se arrepintió tiene que escribir "cancelá" —que funciona, pero hay
que saberlo—, y en un teléfono lo que se ve son los botones.

## Qué hacer

Auditar los trece constructores de `kapso/render.ts` y verificar, uno por uno,
que cada uno tenga una salida tocable o que el paso admita una respuesta escrita
obvia. Donde no entre un botón más (WhatsApp permite tres), el pie del mensaje
tiene que decir cómo salir.

Los que ya la tienen y sirven de patrón: `🗑️ Sacar $X`, `↩️ Volver así`,
`✖️ Cancelar`.
