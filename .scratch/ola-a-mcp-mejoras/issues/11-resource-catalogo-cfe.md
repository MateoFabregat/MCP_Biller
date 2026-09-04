# 11 — Publicar el catálogo CFE como MCP Resource

**What to build:** ofrecer un Resource cacheable y estable con el catálogo de tipos y requisitos CFE que ya conoce el servidor, para que los clientes no necesiten invocar una tool para información estática.

**Blocked by:** 10 — Crear la costura mínima para MCP Resources.

**Status:** ready-for-agent

## Evidencia y punto de partida

- Las tools de catálogo y requisitos ya exponen información local sin consultar la API.
- El valor nuevo es la forma MCP Resource; no hace falta crear otra base de datos ni otra definición fiscal.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- URI estable: `biller://catalogos/cfe`.
- Una sola fuente canónica compartida con las tools existentes.
- Contenido determinístico, read-only, sin red, PII, tenant, secretos ni capacidad de escritura.
- No agregar otros Resources ni internacionalizar el modelo CFE.

## Acceptance criteria

- [ ] `resources/list` anuncia el URI, nombre y tipo de contenido correctos.
- [ ] `resources/read` devuelve el catálogo determinístico desde la fuente canónica.
- [ ] Tests comparan Resource y tools para impedir divergencia semántica.
- [ ] El Resource aparece igual en `read_only` y `write_enabled`.
- [ ] Ninguna lectura genera request HTTP.
- [ ] Los tests de Resource, registro, catálogo, requisitos y dialecto pasan.
- [ ] `npm run typecheck`, `npm run check:readonly` y `npm test` pasan.
