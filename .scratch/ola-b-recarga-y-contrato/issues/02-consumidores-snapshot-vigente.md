# 02 — Hacer que autenticación y webhook lean el snapshot vigente

**What to build:** hacer que cada request MCP y cada webhook multiempresa resuelvan autenticación y empresa contra el snapshot vigente, sin capturar el registro del arranque.

**Blocked by:** 01 — Publicar snapshots atómicos del registro de tenants.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- La credencial sigue siendo el selector de tenant; no aparece ningún header de selección adicional.
- El webhook sigue seleccionando secreto y contexto con datos firmados de infraestructura.
- Una request usa un único snapshot coherente durante toda su resolución.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] Un tenant agregado autentica y atiende sin reiniciar el transporte.
- [ ] Un token eliminado deja de autenticar en la request siguiente.
- [ ] El webhook resuelve tenants agregados o modificados desde el snapshot vigente.
- [ ] Los tests focales, `npm run typecheck` y `npm test` pasan.

