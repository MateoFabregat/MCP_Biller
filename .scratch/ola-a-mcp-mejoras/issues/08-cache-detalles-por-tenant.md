# 08 — Dar ownership por tenant al cache de detalles

**What to build:** reemplazar el singleton compartido de detalles por una instancia propiedad del contexto efectivo de cada empresa, respetando por ahora FIFO, TTL y presupuesto existentes.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- `CacheDetalles` mantiene un mapa de módulo y lee la habilitación del entorno del proceso una sola vez.
- La clave incluye `cacheId`, por lo que hoy no cruza datos, pero una empresa puede desalojar entradas calientes de otra y no puede apagar correctamente su propio cache.
- `CacheVentanas` y `ContextosPorTenant` muestran el patrón de ownership esperado.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Conservar inicialmente FIFO, TTL, máximo de entradas, reintentos, orden de resultados y copias defensivas.
- Un cliente sin `cacheId` nunca se cachea.
- El modo monoempresa mantiene el beneficio entre tools del mismo contexto.
- No migrar todavía a LRU ni cambiar el tamaño del presupuesto.
- Evitar ejecutar este ticket en paralelo con el 06 si ambos tocan contratos compartidos de configuración.

## Acceptance criteria

- [ ] Dos tenants no comparten instancia, presupuesto, hits ni misses.
- [ ] Deshabilitar cache en A no afecta el cache de B.
- [ ] Llenar el cache de A no desaloja entradas de B.
- [ ] Las estadísticas consultan la instancia correcta y no un global residual.
- [ ] No queda lectura directa de `BILLER_CACHE_ENABLED` dentro del módulo de detalles.
- [ ] `npx vitest run tests/cachePorEmpresa.test.ts tests/traerDetalles.test.ts tests/rankingProductos.test.ts tests/cuentaCorriente.test.ts tests/resolver.test.ts` pasa.
- [ ] `npm run typecheck`, `npm run check:readonly` y `npm test` pasan.
