# 01 — Mantener vivos los contratos numéricos de la documentación

**What to build:** corregir los conteos visibles de tools y hacer que cualquier afirmación futura sobre esos conteos falle automáticamente cuando diverja del registro real. Eliminar cifras exactas de cantidad de tests, porque cambian en cada entrega y no describen una capacidad del producto.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- `READ_TOOL_NAMES` y `WRITE_TOOL_NAMES` son la fuente canónica; actualmente representan 27 tools de lectura y 7 de escritura.
- El guard `los documentos no afirman conteos falsos` ya inspecciona varios documentos, pero no el ejemplo de entorno.
- El ejemplo de entorno todavía afirma 6 tools de lectura y 6 de escritura.
- La guía de equipo conserva el texto “1050+ tests”.
- El backlog todavía presenta como pendientes cinco trabajos ya implementados: clasificación producto/cliente, salida para precio final no positivo, invalidación de `precio_copiado`, rutas derivadas de `BILLER_DATA_DIR` y configuración HTTP centralizada.

## Invariantes y no-objetivos

- Los conteos exactos de tools se derivan de las listas canónicas; no agregar otra constante `27`/`7` dentro del guard.
- Limpiar únicamente las cinco entradas obsoletas enumeradas arriba.
- No reescribir la documentación general ni tocar `docs/research/`.

## Acceptance criteria

- [ ] El ejemplo de entorno y las guías describen correctamente 27 tools de lectura y 7 de escritura.
- [ ] El guard inspecciona también el ejemplo de entorno y falla ante un conteo falso inyectado por el test.
- [ ] La documentación no promete una cifra exacta o aproximada de tests que haya que mantener manualmente.
- [ ] Las cinco entradas obsoletas quedan marcadas como resueltas con evidencia breve; ningún otro pendiente cambia.
- [ ] `npx vitest run tests/conteosDoc.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.

