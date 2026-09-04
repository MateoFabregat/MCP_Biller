# 12 — Crear un harness seguro de contrato real, solo lectura

**What to build:** permitir que un operador autorizado capture evidencia mínima y saneada de comportamientos reales de Biller TEST —paginación, filtros, estados y signo de IVA recibido— sin que esas observaciones cambien automáticamente reglas fiscales.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- El script de contrato ya realiza sondas manuales, pero los pendientes fiscales necesitan evidencia reproducible y explícitamente separada de la suite con mocks.
- El resultado de este ticket desbloquea decisiones; no decide por sí solo cómo contar estados ni cómo firmar IVA de notas de crédito.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Opt-in explícito y hard gate a `test.biller.uy`; nunca producción.
- Solo GET. Ningún POST, emisión, anulación, mensaje o mutación.
- Artefactos en una ubicación explícitamente ignorada por Git, creados con modo 0600 desde el primer byte.
- Nunca guardar respuestas raw. Serializar mediante allowlist de campos mínimos y redactar headers, cookies, tokens, RUT/CI/nombres/direcciones y cuerpos no aprobados.
- Los mocks prueban seguridad del harness, no el contrato externo.

## Acceptance criteria

- [ ] Sin flag/env de integración, el harness termina como skip limpio y no llama a la red.
- [ ] Una URL que no sea exactamente el ambiente TEST permitido se rechaza antes de la red.
- [ ] Las sondas capturan únicamente hechos necesarios para paginación, filtros, estados y signo numérico de IVA.
- [ ] El artefacto incluye fecha, versión del harness y resultado anonimizado, pero no credenciales ni datos personales.
- [ ] Tests prueban que headers, cookies, bearer tokens, API keys, cuerpos raw y campos personales no llegan al archivo.
- [ ] Los resultados se etiquetan como evidencia externa pendiente de interpretación, no como test fiscal aprobado.
- [ ] El test focal del harness, `node --check` para el script, `npm run typecheck` y `npm test` pasan.
