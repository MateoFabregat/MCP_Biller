# 09 — Convertir el cache de detalles aislado a LRU

**What to build:** una vez que cada tenant posee su cache, mantener calientes los detalles realmente usados mediante desalojo LRU y estadísticas coherentes.

**Blocked by:** 08 — Dar ownership por tenant al cache de detalles.

**Status:** ready-for-agent

## Evidencia y punto de partida

- El cache aislado del ticket anterior conserva deliberadamente el FIFO previo.
- El cache de ventanas ya contiene un patrón probado de touch-on-hit y desalojo LRU.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Preservar TTL, claves, copias defensivas, habilitación por tenant y política para clientes sin identidad.
- No agregar configuración de tamaño, persistencia ni un cache distribuido.
- El cambio afecta solo el orden de desalojo.

## Acceptance criteria

- [ ] Con capacidad 2 y secuencia `A, B, hit A, C`, se desaloja B y A permanece.
- [ ] Una entrada vencida cuenta como miss y se elimina.
- [ ] Hits, misses y entradas reflejan exactamente la secuencia observada.
- [ ] Un `set` de una clave existente la mueve a la posición más reciente sin inflar el tamaño.
- [ ] Los tests focales del cache y sus consumidores pasan.
- [ ] `npm run typecheck`, `npm run check:readonly` y `npm test` pasan.
