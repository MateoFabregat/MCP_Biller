# 05 — Extender el guard de fecha uruguaya a fixtures representativos

**What to build:** detectar en tests los defaults de día civil basados accidentalmente en UTC, sin marcar como errores los instantes técnicos usados para TTL, auditoría, fake clocks o timestamps.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- El guard actual barre el código productivo y ya reconoce cuatro familias de `new Date()`.
- Bugs anteriores aparecieron en fixtures que fallaban durante la ventana 21:00–00:00 de Uruguay.
- El marker vigente es `// fecha-uy:allow <motivo>` y el motivo no puede estar vacío.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Primera entrega limitada a: `?? new Date()`, bindings `const/let/var`, defaults `x: Date = new Date()` y llamadas `helper(new Date())` en fixtures representativos.
- Los conversores `hoyIsoUy`, `hoyDgiUy` y `hoyComoDateUy` siguen redimiendo un instante.
- Excluir `toISOString()` de logs, TTL, timestamps y fake clocks con marker razonado.
- No construir un parser completo de TypeScript ni migrar patrones no observados.

## Acceptance criteria

- [ ] Un fixture sintético que usa `new Date()` como día civil genera una violación legible.
- [ ] Un instante convertido inmediatamente a día uruguayo no genera violación.
- [ ] Un uso técnico con marker y motivo no genera violación; un marker vacío falla.
- [ ] El propio archivo del guard no se denuncia a sí mismo.
- [ ] `npx vitest run tests/fechaUyGuard.test.ts` pasa.
- [ ] Las pruebas de fecha relevantes pasan también con `TZ=UTC`.
- [ ] `npm run typecheck` y `npm test` pasan.
