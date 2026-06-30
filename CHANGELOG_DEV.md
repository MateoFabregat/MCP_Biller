# CHANGELOG_DEV

Changelog orientado a desarrolladores. Sigue [Keep a Changelog](https://keepachangelog.com/es/).

---

## [Unreleased] — 2026-06-29

### Added

**Modo operativo `BILLER_CAPABILITY_MODE`**
- Nueva variable de entorno `BILLER_CAPABILITY_MODE` (`read_only` | `write_enabled`).
  Default: `read_only`. Controla qué tools se registran en el servidor MCP.
- En `read_only` solo se registran las 6 tools de lectura; las de escritura
  no aparecen en MCP Inspector ni en Claude (no están registradas en el servidor).
- En `write_enabled` se registran las 12 tools (lectura + escritura).
- `src/config.ts`: tipo `BillerCapabilityMode`, función `parseCapabilityMode`.
  Normaliza cualquier valor desconocido a `read_only` (fail-safe).
- `src/tools/register.ts`: constantes `READ_TOOL_NAMES`, `WRITE_TOOL_NAMES`,
  `REGISTERED_TOOL_NAMES`, `PENDING_TOOLS`. Función `getRegisteredToolNames(mode)`.
  `registerAllTools(server, ctx, mode)` gatea las tools de escritura por `mode`.

**Tools de escritura con barreras** (`src/tools/write/`, `src/write/`)
- 6 tools POST: `biller_emitir_comprobante`, `biller_anular_comprobante`,
  `biller_crear_cliente`, `biller_cargar_producto`, `biller_crear_recibo`,
  `biller_cancelar_recibo`.
- Todas usan `runWriteOperation` del helper `src/tools/write/shared.ts`.
- Flujo de dos fases: dry-run (preview, sin red) → ejecución con `confirm=true`.
- `confirmation_token`: SHA-256 de `{endpoint}:{environment}:{JSON.stringify(payload)}`.
  Si cualquier campo del payload cambia, el token deja de valer.
- Gate de escritura (`src/write/gate.ts`): `BILLER_WRITE_ENABLED=true` requerido.
- Gate de producción: si `environment=production`, requiere además
  `BILLER_ALLOW_PRODUCTION_WRITES=true` (env) + `allow_production=true` (argumento).
- Idempotencia in-process (`src/write/idempotency.ts`): misma `idempotency_key`
  no se ejecuta dos veces por sesión; el header `Idempotency-Key` se envía al servidor.
- Audit log (`src/write/audit.ts`): cada intento se registra a stderr con
  `audit_id`, `ts`, `tool`, `endpoint`, `environment`, `phase`, `payload_sha256`,
  `http_status`, `outcome`. El token nunca se registra.
- `src/write/writeClient.ts`: cliente HTTP POST dedicado, aislado del cliente GET.
- `src/biller/httpGuard.ts`: guard runtime que bloquea verbos distintos de GET
  en el cliente de lectura.

**`biller_health_check` mejorado**
- Nuevos campos en la respuesta: `capability_mode`, `write_tools_registered`,
  `write_execution_enabled`, `allow_production_writes`.
- `warnings`: lista de alertas de configuración inconsistente:
  - `write_enabled` sin `BILLER_WRITE_ENABLED=true` (tools visibles, ejecución bloqueada)
  - `BILLER_WRITE_ENABLED=true` sin `BILLER_CAPABILITY_MODE=write_enabled`
  - Escritura habilitada en producción sin `allow_production_writes`
  - Escritura en producción con `allow_production_writes=true` (aviso grave)
- Modo markdown (`response_format=markdown`) incluye todos los campos nuevos.

**Write-isolation guard**
- `scripts/check-readonly.mjs` (`npm run check:readonly`): falla si aparece
  `POST/PUT/PATCH/DELETE` fuera de los directorios `write/` en `src/`.
- `tests/readonly.test.ts`: equivalente en Vitest + verifica que `writeClient.ts`
  use `WRITE_METHOD = "POST"` y que `client.ts` use `ALLOWED_METHOD = "GET"`.

### Changed

- `src/index.ts`: pasa `inspection.capabilityMode` a `registerAllTools`;
  logea `capability_mode` y la lista de tools registradas al arrancar.
- `.env.example`: secciones "Modo operativo" y "Escritura con barreras" documentadas.
- `README.md`: tabla de variables, descripción de modos, flujo de escritura,
  instrucciones para inspector y Claude Desktop/Code.
- `evals/evaluation.xml` v2: 16 casos incluyendo escritura (cases 9-14),
  mode/health (15-16) y capacidades pendientes (10).

### Tests

- `tests/config.test.ts`: 5 tests nuevos para `BILLER_CAPABILITY_MODE` en
  `loadConfig` e `inspectConfig` (default, write_enabled, valor desconocido).
- `tests/health.test.ts`: 10 tests cubriendo todos los campos del health check,
  warnings por configuración inconsistente, producción habilitada, markdown.
- `tests/registry.test.ts`: 7 tests — read_only (6 tools), write_enabled (12 tools),
  exclusión de `biller_listar_clientes`, default sin modo explícito.
- `tests/write.test.ts`: 13 tests — dry-run, gate write_disabled, ejecución OK,
  token inválido, idempotencia, validación, gate de producción (3 casos),
  anular, cancelar recibo.
- `tests/readonly.test.ts`: 3 tests — guard estático de write-isolation.
- Total: **90 tests** en 13 archivos. Sin tests de integración (sin red real).

### Security

- Las tools de escritura no se registran en `read_only` (default), eliminando
  la superficie de ataque en deployments de solo lectura.
- El `confirmation_token` vincula el payload al endpoint y al ambiente, evitando
  replay cross-ambiente o con payload modificado.
- El doble gate de producción (env + argumento) requiere acción explícita en
  cada llamada, no solo configuración.
- El audit log nunca registra el token ni el payload completo; solo el hash
  SHA-256 del payload y la metadata de la operación.

---

## [0.1.0] — 2026-06-28 (commit inicial)

### Added

- Implementación inicial del MCP de Biller.
- 6 tools de lectura: health_check, buscar_cliente_por_rut,
  listar_comprobantes_emitidos, listar_comprobantes_recibidos,
  obtener_comprobante, resumen_facturacion_periodo.
- Cliente HTTP GET con rate limiting por clase.
- Normalización de comprobantes y clasificación de tipos CFE.
- Transporte stdio, build TypeScript, suite Vitest.
