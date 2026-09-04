# 06 — Las tasas de IVA viven en un solo lugar

**What to build:** que exista una sola definición de las tasas de IVA, para que cambiarlas no deje una nota de crédito acreditando con la tasa vieja.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** ALTA (una NC mal calculada acredita IVA que no se pagó) · **Archivo:** `src/services/anulacion.ts`

## Evidencia

`services/anulacion.ts` importa `TASA_IVA` de `calcularTotales.ts` para una rama, **y además define sus propias** `TASA_BASICA = 0.22` y `TASA_MINIMA = 0.1`, que usa para reconstruir el bruto de la nota de crédito.

Modo de falla: DGI cambia una tasa (pasó en 2007 con la mínima), alguien edita `TASA_IVA`, y la NC sigue acreditando con la vieja. Sale bien formada, DGI la acepta, y la empresa se acredita IVA que no pagó. **Nada falla ni avisa.** Es el mismo bug que el encabezado de ese archivo dice haber cerrado, reabierto por duplicación.

El mismo archivo define `redondear2` **sin** `Number.EPSILON`, mientras el resto del sistema usa `round2` de `biller/coerce.ts` que sí lo tiene.

## Qué hacer

1. Borrar `TASA_BASICA` y `TASA_MINIMA` de `anulacion.ts`; usar `TASA_IVA[IND_BASICA]!` y `TASA_IVA[IND_MINIMA]!` (el import ya existe).
2. Borrar `redondear2` y usar `round2` de `biller/coerce.ts`.
3. Dejar un comentario donde estaban, explicando que las tasas viven en `calcularTotales.ts` y por qué no se duplican.

## Invariantes

- Los números resultantes no cambian hoy (0.22 y 0.1 son los mismos): el test tiene que probar el ACOPLE, no el valor.
- No tocar la lógica de qué porción de la NC lleva cada tasa.

## Acceptance criteria

- [ ] Test en `tests/anulacion.test.ts` que cambie `TASA_IVA` de la tasa mínima a 0.12 y verifique que el bruto de esa porción cambia. Si no cambia, la duplicación volvió.
- [ ] Los tests existentes de anulación siguen dando los mismos importes.
- [ ] `npm run typecheck` y `npm test` pasan.
