# 07 — Construir rate limiters aislados desde cada contexto

**What to build:** hacer que cada tenant use sus límites efectivos sin compartir presupuesto con otras empresas, manteniendo los defaults y la clasificación de requests existentes.

**Blocked by:** 06 — Incorporar rate limits a la configuración validada.

**Status:** ready-for-agent

## Evidencia y punto de partida

- `createToolContext` crea actualmente el par de limiters antes de leer la configuración.
- `IntervalRateLimiter` ya permite inyectar reloj y espera para tests.
- Cada tenant posee un `ToolContext`, que es la frontera correcta del presupuesto.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Los defaults efectivos siguen equivalentes a intervalos de 34 ms y 1000 ms.
- Un limiter pertenece a un contexto; nunca a todo el proceso.
- Las tools conservan su clase actual `default` o `dgi`.
- No implementar token bucket, prioridades ni coordinación distribuida.

## Acceptance criteria

- [ ] La fábrica recibe los valores efectivos de configuración y crea ambos intervalos correctamente.
- [ ] La construcción desde `ToolContext` ocurre después de disponer de la configuración efectiva.
- [ ] Dos tenants tienen estado de limiter independiente.
- [ ] Tests con reloj/espera falsos verifican intervalos custom y defaults sin sleeps reales.
- [ ] Los tests de cliente y escritura confirman que cada endpoint conserva su clase.
- [ ] `npx vitest run tests/config.test.ts tests/client.test.ts tests/writeClient.test.ts tests/tenants.test.ts` pasa.
- [ ] `npm run typecheck`, `npm run check:readonly` y `npm test` pasan.
