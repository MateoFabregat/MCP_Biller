# 20 — El precio escrito se lee

**What to build:** que un número escrito en el paso del precio se tome como el precio.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** ALTA (es una de las dos respuestas más frecuentes del producto) · **Archivos:** `src/kapso/emision.ts`, `src/tools/emisionGuiada.ts`

## Evidencia

El paso pregunta textualmente **"¿A qué precio por unidad? Solo el número."** y el usuario escribe `6500`. El server no lo lee: la pregunta se repite. Depende enteramente de que el agente copie el número al borrador.

Es la pregunta que rechaza su propia respuesta número **cinco** de este proyecto. Las cuatro anteriores —el RUT, la fecha, el IVA y "sin identificar"— ya se arreglaron con el mismo patrón.

Está documentado como decisión ("las preguntas de ítem no se contestan con texto crudo"). **El argumento vale para el concepto y no para el precio:** un número pelado en el paso del precio no tiene ninguna ambigüedad sobre a qué campo va, y el paso de la tasa de cambio ya hace exactamente esto.

## Qué hacer

En la interpretación de respuestas libres, agregar el caso del paso `precio`:

- Aceptar **solo** si el mensaje es un número (con símbolo de peso opcional, puntos y comas). Cualquier otra cosa sigue devolviendo "ninguna": ante la duda no se elige.
- Parsear con el parser de importes que ya existe, que además marca la ambigüedad de "6.50".
- Si el valor es cero o negativo, no aceptar.
- Propagar la marca de ambigüedad al ítem, igual que ya se hace cuando el precio viene del extractor: eso es lo que hace aparecer el aviso en el preview.

**No tocar el paso del concepto**: esa decisión queda como está y documentada.

## Acceptance criteria

- [ ] "6500", "6.500", "$ 6.500" y "6500,50" fijan el precio correcto.
- [ ] "6.50" fija 6,50 **y** marca la ambigüedad.
- [ ] "unos 6500" y "eran 3 no 2" siguen devolviendo "ninguna".
- [ ] Escribiendo "6500" en el paso del precio, el paso siguiente es el del IVA.
- [ ] `npm run evals` en 44/44 o más.
- [ ] `npm run typecheck` y `npm test` pasan.
