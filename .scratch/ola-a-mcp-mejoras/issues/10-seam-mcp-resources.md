# 10 — Crear la costura mínima para MCP Resources

**What to build:** incorporar una ruta central y testeable para registrar Resources MCP, validando `resources/list` y `resources/read` sin publicar todavía contenido productivo.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- El servidor centraliza hoy el registro de tools, pero no existe ninguna llamada de registro de Resources.
- El harness de protocolo usado para schemas y dialecto puede servir como referencia para invocar capacidades MCP reales.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- El registro productivo queda vacío hasta el ticket 11.
- Un descriptor sintético puede inyectarse únicamente desde el harness de test y nunca debe aparecer en un servidor normal.
- Resources son read-only, sin llamadas a Biller, datos de tenant ni side effects.
- No publicar todavía el catálogo CFE ni duplicar su modelo.

## Acceptance criteria

- [ ] Existe una costura central `registerAllResources` o equivalente integrada al armado del servidor.
- [ ] El harness puede inyectar un Resource sintético y verificar `resources/list` y `resources/read` por protocolo.
- [ ] Un servidor normal no lista el Resource sintético ni ningún otro Resource antes del ticket 11.
- [ ] Capability mode de escritura no cambia la naturaleza read-only de la costura.
- [ ] Los tests de protocolo, registro y dialecto pasan.
- [ ] `npm run typecheck`, `npm run check:readonly` y `npm test` pasan.
