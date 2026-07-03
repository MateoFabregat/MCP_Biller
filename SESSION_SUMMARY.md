# SESSION_SUMMARY — 2026-06-29

## Objetivo

Productizar el MCP de Biller implementando un modo operativo explícito
(`BILLER_CAPABILITY_MODE`) que controla qué tools se registran en el servidor,
y reforzar todas las barreras de seguridad de escritura.

## Qué se implementó

### Modo operativo (`BILLER_CAPABILITY_MODE`)

| Modo | Tools registradas | Escritura real |
|---|---|---|
| `read_only` (default) | 6 tools de lectura | No disponible |
| `write_enabled` | 12 tools (lectura + escritura) | Solo con barreras |

La variable es evaluada en `src/config.ts` (`parseCapabilityMode`) y aplicada
en `src/tools/register.ts` (`registerAllTools`). El servidor lee el modo en
startup y lo logea junto con las tools registradas.

### Tools de lectura (siempre registradas)

- `biller_health_check`
- `biller_buscar_cliente_por_rut`
- `biller_listar_comprobantes_emitidos`
- `biller_listar_comprobantes_recibidos`
- `biller_obtener_comprobante`
- `biller_resumen_facturacion_periodo`

### Tools de escritura (solo en `write_enabled`)

- `biller_emitir_comprobante`
- `biller_anular_comprobante`
- `biller_crear_cliente`
- `biller_cargar_producto`
- `biller_crear_recibo`
- `biller_cancelar_recibo`

Cada tool de escritura pasa por: dry-run → `confirmation_token` → confirm +
`BILLER_WRITE_ENABLED=true` → (si prod) `BILLER_ALLOW_PRODUCTION_WRITES=true`
+ `allow_production=true` → idempotencia → audit log.

### `biller_health_check` actualizado

Reporta:
- `capability_mode` — modo operativo actual
- `write_tools_registered` — booleano derivado del modo
- `write_execution_enabled` — `BILLER_WRITE_ENABLED`
- `environment` — `test` o `production` (derivado de la URL)
- `has_token` — nunca expone el token
- `allow_production_writes` — flag de producción
- `warnings` — alertas de configuración inconsistente
- `missing` — variables requeridas ausentes

### Archivos actualizados

- `src/config.ts` — tipo `BillerCapabilityMode`, `parseCapabilityMode`, campos en `BillerConfig` e `ConfigInspection`
- `src/tools/register.ts` — `READ_TOOL_NAMES`, `WRITE_TOOL_NAMES`, `getRegisteredToolNames`, `registerAllTools` con gate
- `src/tools/health.ts` — `buildWarnings`, `buildHealthStructured`, `toMarkdown` con todos los campos
- `src/index.ts` — pasa `capabilityMode` a `registerAllTools`, logea las tools registradas
- `src/write/gate.ts` — doble gate: `BILLER_WRITE_ENABLED` + gate de producción
- `src/write/execute.ts` — orquestación: dry-run vs ejecución + audit
- `src/write/confirm.ts` — generación y validación de `confirmation_token`
- `src/write/idempotency.ts` — deduplicación in-process por `idempotency_key`
- `src/write/audit.ts` — audit log a stderr (+ archivo opcional)
- `src/tools/write/*.ts` — 6 tools con `runWriteOperation`
- `tests/config.test.ts` — tests de `BILLER_CAPABILITY_MODE`
- `tests/health.test.ts` — tests de todos los campos del health check
- `tests/registry.test.ts` — tests de registro de tools por modo
- `tests/write.test.ts` — tests de dry-run, gate, producción, idempotencia
- `tests/readonly.test.ts` — guard estático de write-isolation
- `.env.example` — documentación de todas las variables con comentarios
- `evals/evaluation.xml` — 16 casos: lectura, escritura, modos, producción

## Resultados de verificación

```
npm run build      → OK (cero errores TypeScript)
npm run typecheck  → OK (cero errores)
npm run check:readonly → OK (escritura aislada en write/)
npm test           → 90/90 tests passed (13 archivos)
```
