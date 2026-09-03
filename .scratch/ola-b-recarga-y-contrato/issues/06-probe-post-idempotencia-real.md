# 06 — Agregar un probe real de POST e idempotencia con doble opt-in

**What to build:** agregar un comando contractual que, únicamente contra el ambiente de test y con habilitación explícita, ejecute una operación POST controlada y compruebe que repetir la misma clave de idempotencia no duplica el efecto.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- Por defecto no se realiza ningún POST.
- El probe rechaza bases que no sean exactamente el ambiente de test permitido.
- Requiere credenciales y datos dedicados, una clave de ejecución explícita y una confirmación adicional.
- No imprime tokens, cuerpos fiscales completos ni datos personales.
- No habilita escritura del servidor MCP ni relaja ninguna barrera existente.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] Sin todos los opt-ins el proceso termina antes de llamar a la red.
- [ ] Una base no permitida se rechaza antes de llamar a la red.
- [ ] El mismo identificador y clave de idempotencia se usan en ambos intentos.
- [ ] La salida informa únicamente estados y evidencia mínima saneada.
- [ ] El comportamiento de gating se cubre sin red real; el probe externo queda fuera de `npm test`.
- [ ] Los tests focales, `npm run typecheck` y `npm test` pasan.

