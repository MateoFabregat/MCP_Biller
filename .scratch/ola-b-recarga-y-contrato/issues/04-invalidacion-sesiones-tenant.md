# 04 — Cerrar sesiones de tenants removidos o modificados

**What to build:** conectar la invalidación del registro con el registro de sesiones HTTP para cerrar las sesiones pertenecientes a tenants eliminados o modificados, incluyendo rotación de credenciales.

**Blocked by:** 02 — Hacer que autenticación y webhook lean el snapshot vigente; 03 — Invalidar contextos solamente para tenants cambiados.

**Status:** ready-for-agent

## Invariantes y no-objetivos

- Cerrar una sesión implica cerrar su transporte, no solo borrar una entrada.
- Las sesiones de tenants sin cambios permanecen vivas.
- Una sesión abierta con una credencial revocada no puede continuar.
- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.

## Acceptance criteria

- [ ] La recarga cierra todas las sesiones de cada tenant eliminado o modificado.
- [ ] Las sesiones de tenants intactos continúan disponibles.
- [ ] La cantidad cerrada queda disponible para diagnóstico sin exponer secretos.
- [ ] Los tests focales, `npm run typecheck` y `npm test` pasan.

