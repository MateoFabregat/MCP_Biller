# 06 — Incorporar rate limits a la configuración validada

**What to build:** permitir que un operador configure los límites normales y DGI sin cambiar todavía la construcción runtime de los limiters, conservando el comportamiento observable actual cuando no configura nada.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- Los defaults actuales son 30 requests por segundo para operaciones normales y 1 para DGI/recibidos.
- Esos valores viven dentro de `createDefaultRateLimiters` y no aparecen en la configuración ni en health.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Sin variables nuevas, el comportamiento debe seguir siendo 30 req/s y 1 req/s.
- Solo aceptar enteros positivos dentro de límites operativos razonables; un valor inválido vuelve explícitamente al default y produce warning, nunca `0`, infinito o limiter apagado.
- Health expone números, no secretos.
- Este ticket no modifica todavía `IntervalRateLimiter` ni `createToolContext`.

## Acceptance criteria

- [ ] La configuración cargada e inspeccionada contiene ambos límites efectivos.
- [ ] El ejemplo de entorno documenta las variables, defaults y unidades.
- [ ] Health muestra los valores efectivos y warning ante valores inválidos.
- [ ] Ausencia de variables produce exactamente 30 y 1.
- [ ] Pruebas cubren válido, ausente, cero, negativo, decimal, texto y valor excesivo.
- [ ] `npx vitest run tests/config.test.ts tests/health.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
