# 05 — Recargar el registro de tenants con SIGHUP

**What to build:** permitir que el proceso HTTP recargue y valide el registro completo ante `SIGHUP`, publique el nuevo snapshot e invalide estado afectado solamente si la carga fue exitosa.

**Blocked by:** 04 — Cerrar sesiones de tenants removidos o modificados.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- Un registro inválido conserva registro, contextos y sesiones anteriores.
- El proceso mono-tenant sin fuente de registro ignora `SIGHUP` sin ruido.
- No se observa estado intermedio y las recargas se serializan.
- No agregar file watchers ni endpoint HTTP de recarga.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] Una recarga válida publica el nuevo registro e invalida solo el estado afectado.
- [ ] Una recarga inválida registra un error y el servidor sigue usando el snapshot anterior.
- [ ] El modo sin fuente de tenants no instala trabajo de recarga ni genera advertencias.
- [ ] Los tests focales, `npm run typecheck` y `npm test` pasan.

