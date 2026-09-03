# 01 — Publicar snapshots atómicos del registro de tenants

**What to build:** introducir un holder del registro que entregue el snapshot vigente y permita reemplazarlo de una sola vez, de modo que una recarga nunca exponga un registro parcialmente construido.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- Un reemplazo publica únicamente un `RegistroTenants` ya validado.
- Los lectores anteriores que conservan un snapshot observan una versión coherente.
- No agregar watchers ni endpoints de administración.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] La API pública permite leer el snapshot actual y reemplazarlo atómicamente.
- [ ] Un test demuestra que antes del reemplazo se ve íntegramente el registro viejo y después íntegramente el nuevo.
- [ ] El modo sin tenants conserva su comportamiento.
- [ ] El test focal, `npm run typecheck` y `npm test` pasan.

