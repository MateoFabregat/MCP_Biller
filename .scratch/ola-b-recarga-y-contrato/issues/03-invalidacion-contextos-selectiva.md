# 03 — Invalidar contextos solamente para tenants cambiados

**What to build:** al publicar un registro nuevo, descartar los contextos de tenants eliminados o cuyo entorno cambió, preservando por identidad los contextos de tenants sin cambios.

**Blocked by:** 01 — Publicar snapshots atómicos del registro de tenants.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- La comparación del entorno es estable frente al orden de las claves.
- Un cambio de `auth_token` invalida aunque el overlay de entorno no cambie.
- Los archivos persistentes no se eliminan; el próximo acceso reconstruye el contexto.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] Un tenant con configuración cambiada recibe un contexto nuevo.
- [ ] Un tenant sin cambios conserva exactamente el mismo objeto de contexto.
- [ ] Un tenant eliminado pierde su contexto cacheado.
- [ ] Los tests focales, `npm run typecheck` y `npm test` pasan.

