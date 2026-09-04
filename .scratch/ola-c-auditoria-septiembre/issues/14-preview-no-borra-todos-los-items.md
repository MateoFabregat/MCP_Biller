# 14 — El preview no puede quedarse sin una sola línea de ítem

**What to build:** que subir el aviso de precio ambiguo al bloque crítico no borre el detalle entero ni corte avisos a mitad de palabra.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media (fiscal: se aprueba un total sin ver nada) · **Archivo:** `src/services/calcularTotales.ts`

## Evidencia

Hoy se movieron los avisos de precio ambiguo al bloque crítico, que no se recorta. Con el presupuesto real (1024 menos el envoltorio, ~776 con una razón social de 150), medido:

| Escenario | Ítems visibles antes | Ítems visibles ahora |
|---|---|---|
| 20 ítems + receptor obligatorio + 3 precios ambiguos | 8 | **0** |
| 1 ítem + 6 precios ambiguos | 1 | **0** |

Y el bloque crítico se corta a mitad de palabra: `"…se leyó $0,25 por un…"`. De seis avisos quedan tres, y los otros tres desaparecen **sin** el "… y N aviso(s) más" que antes sí aparecía.

O sea: la persona aprueba un TOTAL sin ver una sola línea, y los avisos que el módulo llama "el único donde el total puede estar mal por cien veces" se pierden en silencio. Es lo contrario de lo que el cambio prometía.

## Qué hacer

1. Recortar el bloque crítico **por aviso entero**, no por caracteres: acumular avisos completos mientras entren y cerrar con `"… y N aviso(s) crítico(s) más"`. La lógica ya existe en `agregarAvisos`: reusarla, no reescribirla.
2. Reservar en los "esenciales" **al menos la primera línea de ítems** y, si hay ítems ocultos, la línea que los declara. Un preview sin ninguna línea no es un preview.

## Invariantes

- El TOTAL, los supuestos y la pregunta siguen sin recortarse nunca.
- Ningún aviso puede quedar cortado a mitad de palabra.
- Si algo se cae, el mensaje lo declara con un conteo.

## Acceptance criteria

- [ ] Test: 1 ítem + 6 precios ambiguos con `max_chars: 776` → el texto contiene "… y 3 aviso" y **contiene la línea del ítem**.
- [ ] Test: ningún aviso termina cortado (no matchea `/por un…$/m`).
- [ ] Test: 20 ítems + receptor obligatorio + 3 ambiguos → al menos una línea de ítem y la declaración de los ocultos.
- [ ] `npx vitest run tests/calcularTotales.test.ts tests/regresionesAuditoria.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
