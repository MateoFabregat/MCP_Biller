# 21 — La dirección del cliente nuevo se lee, y no se confunde con un pedido

**What to build:** que la respuesta a "¿dirección y ciudad?" se guarde, y que el extractor no la lea como una venta.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media (dos bugs en el mismo mensaje) · **Archivos:** `src/kapso/emision.ts`, `src/tools/emisionGuiada.ts`

## Evidencia

El paso pide dirección y ciudad. El usuario escribe `"Av. Italia 1234 apto 302, Montevideo"`. Pasan dos cosas, las dos malas:

1. **No se guarda** y la pregunta se repite (la interpretación de respuestas libres no tiene ese caso).
2. **El extractor lo lee como un pedido**: cliente "av italia", ítem "apto" × 1234 a $302. Con un ítem abierto **abre una línea fantasma de $302** y avisa "NO emitas hasta cargarlos o descartarlos".

Con el ejemplo que da la propia pregunta —"Rivera 1234, Melo"— sale un ítem "melo" × 1234.

## Qué hacer

1. Leer la respuesta en ese paso: la función que separa dirección de ciudad **ya existe**. Si el estado ya tiene dirección y falta la ciudad (la repregunta), el mensaje entero es la ciudad.
2. **El extractor no corre** cuando el paso abierto es uno donde el mensaje no puede ser un pedido: dirección, tasa de cambio, fecha y fecha de vencimiento. Un número ahí no es un precio.

## Invariantes

- El paso abierto se calcula sobre el estado **anterior** a aplicar el mensaje.
- Una dirección sin coma sigue repreguntando solo la ciudad, como hoy.

## Acceptance criteria

- [ ] "Av. Italia 1234 apto 302, Montevideo" guarda dirección y ciudad y avanza de paso.
- [ ] No aparece ningún ítem nuevo ni ningún warning que mencione $302.
- [ ] "Ruta 8 km 32" repregunta solo la ciudad.
- [ ] `npm run evals` en 44/44 o más.
