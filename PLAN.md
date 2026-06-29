# Plan técnico — Biller MCP Read-Only MVP

## 1. Resumen ejecutivo

Construir un MCP server local, TypeScript/Node.js, por `stdio`, estrictamente read-only para consultar Biller usando endpoints GET documentados en el OpenAPI público: [OpenAPI JSON](https://francodest-biller-v3-docs.apidocumentation.com/openapi.json).

Hallazgo clave: la documentación pública no incluye endpoints GET para listar clientes ni buscar clientes registrados en Biller. Sí incluye consultas de comprobantes y consultas DGI por RUT/documento. Todo lo no documentado queda pendiente de validación.

## 2. Objetivo del MVP

Permitir preguntas conversacionales sobre comprobantes emitidos, comprobantes recibidos y datos DGI de entidades, sin emitir, anular, crear ni modificar nada.

## 3. Alcance y no alcance

MVP:
- MCP local por `stdio`.
- Bearer Token desde variables de entorno.
- Solo llamadas `GET`.
- Tools de comprobantes emitidos/recibidos, obtención por ID o tipo/serie/número, consulta DGI por RUT y resumen de facturación.

Fuera de alcance:
- Cualquier `POST`: `/v2/clientes/crear`, `/v2/comprobantes/crear`, `/v2/comprobantes/anular`, `/v2/productos/cargar`, `/v2/recibos/crear`, `/v2/recibos/cancelar`.
- Listado real de clientes Biller hasta validar endpoint.
- Conversión de moneda.
- Deploy remoto.

## 4. Arquitectura propuesta

- `MCP server`: registra tools con `@modelcontextprotocol/sdk`.
- `Config`: valida env vars y defaults.
- `Biller client`: cliente HTTP GET-only con Bearer Token, timeout, rate limit y redacción de secretos.
- `Normalizers`: transforman respuestas reales a modelos internos estables.
- `Services`: agregación de facturación y clasificación por tipo de comprobante.
- `Tools`: validan inputs con Zod y devuelven `structuredContent`.

## 5. Transporte MCP recomendado

Usar `stdio` para MVP local. No loguear en `stdout`; logs solo a `stderr`.

Dejar preparado `Streamable HTTP` como roadmap, no implementarlo ahora.

## 6. Variables de entorno y configuración

Requeridas:
- `BILLER_API_BASE_URL`, ejemplo `https://test.biller.uy` o `https://biller.uy`.
- `BILLER_API_TOKEN`.

Opcionales:
- `BILLER_DEFAULT_EMPRESA_RUT`: solo metadata local; el token ya está asociado a una empresa.
- `BILLER_DEFAULT_SUCURSAL_ID`: recomendado porque `/v2/comprobantes/obtener` documenta `sucursal`.
- `BILLER_TIMEOUT_MS`, default `30000`.
- `LOG_LEVEL`, default `info`.

## 7. Estructura de carpetas

```text
biller-mcp-server/
  src/
    index.ts
    config.ts
    biller/client.ts
    biller/types.ts
    biller/normalize.ts
    tools/health.ts
    tools/comprobantes.ts
    tools/dgi.ts
    services/resumenFacturacion.ts
    utils/errors.ts
    utils/rateLimit.ts
  tests/
    fixtures/
    client.test.ts
    comprobantes.test.ts
    resumenFacturacion.test.ts
    readOnlyGuard.test.ts
  evals/evaluation.xml
  .env.example
  README.md
  package.json
  tsconfig.json
  .github/workflows/ci.yml
```

## 8. Contrato de tools del MVP

Usar nombres prefijados para evitar colisiones MCP. Entre paréntesis queda el nombre solicitado originalmente.

### `biller_health_check` (`health_check`)
- Descripción: verifica que el server carga config mínima sin exponer secretos.
- Cuándo: diagnóstico local.
- Input: `{ response_format?: "json" | "markdown" }`.
- Output: `{ status, api_base_url, has_token, default_empresa_rut?, default_sucursal_id? }`.
- Endpoint Biller: ninguno.
- Supuestos a validar: ninguno.
- Errores: config faltante.
- Seguridad: nunca devolver token.

### `biller_buscar_cliente_por_rut` (`buscar_cliente_por_rut`)
- Descripción: consulta datos públicos DGI por RUT; no confirma que sea cliente registrado en Biller.
- Cuándo: “¿qué empresa corresponde a este RUT?”.
- Input: `{ rut: string, detalle?: "nombre" | "datos_entidad" | "actividad" }`.
- Output: normalizado desde campos documentados como `RazonSocial`, `RUC`, `Denominacion`, `EstadoActividad`.
- Endpoints: `/v2/dgi/empresas/nombre-entidad`, `/v2/dgi/empresas/datos-entidad`, opcional `/v2/dgi/empresas/actividad-empresarial`.
- Supuestos pendientes: endpoint real para buscar clientes propios de Biller.
- Errores: 400, 403, 404, 422, 429, 500.
- Seguridad: rate limit 1 req/s para consultas DGI.

### `biller_listar_clientes` (`listar_clientes`)
- Estado: no registrar en MVP hasta validar endpoint GET de clientes.
- Motivo: OpenAPI público solo documenta `POST /v2/clientes/crear`.
- Supuesto pendiente: existencia de endpoint GET/list/search de clientes Biller y su schema.

### `biller_listar_comprobantes_emitidos` (`listar_comprobantes_emitidos`)
- Descripción: lista comprobantes emitidos según criterios documentados.
- Cuándo: facturación por período, búsqueda por CFE, cliente o número interno si esos campos están disponibles.
- Input: `{ desde?: "YYYY-MM-DD HH:mm:ss", hasta?: "YYYY-MM-DD HH:mm:ss", sucursal?: string, id?: string, tipo_comprobante?: string, serie?: string, numero?: string, numero_interno?: string, limit?: number }`.
- Output: array con campos documentados: `id`, `tipo_comprobante`, `serie`, `numero`, `moneda`, `total`, `cliente`, `esNotaAjuste`, `fecha_creacion`, `fecha_emision`, `fecha_vencimiento`, `cae`, `indicador_cobranza_propia`, IVA documentado.
- Endpoint: `GET /v2/comprobantes/obtener`.
- Supuestos pendientes: paginación, campo de estado/anulación para emitidos, estructura real de `cliente`.
- Errores: rango de fechas inválido, combinaciones incompletas `tipo_comprobante + serie + numero`.
- Seguridad: GET-only; no llamar PDF salvo tool separada futura.

### `biller_listar_comprobantes_recibidos` (`listar_comprobantes_recibidos`)
- Descripción: lista comprobantes recibidos documentados.
- Cuándo: “qué comprobantes recibidos tengo de un proveedor”.
- Input: `{ fecha_desde: "YYYY-MM-DD", fecha_hasta: "YYYY-MM-DD", proveedor_rut?: string, moneda?: string, tipo?: number, estado?: string, limit?: number }`.
- Output: campos documentados: `tipo`, `serie`, `numero`, `estado`, `fecha`, `rut_emisor`, `moneda`, `total_neto`, `total_iva`, `monto_total`, `total_retenido`.
- Endpoint principal: `GET /v2/comprobantes/recibidos/obtener`.
- Endpoint alternativo pendiente: `GET /v2/comprobantes/obtener?recibidos=1`.
- Supuestos pendientes: cuál endpoint es canónico para recibidos y si hay paginación.
- Seguridad: tratarlo como consulta DGI con 1 req/s.

### `biller_obtener_comprobante` (`obtener_comprobante`)
- Descripción: obtiene detalle de un comprobante existente.
- Cuándo: ver detalle por `id` o `tipo_comprobante + serie + numero`.
- Input: `{ id?: string, sucursal?: string, tipo_comprobante?: string, serie?: string, numero?: string, numero_interno?: string, recibidos?: boolean }`.
- Output: mismo modelo de comprobante; `items` y `retenciones_percepciones` solo si la API los devuelve con `id`.
- Endpoint: `GET /v2/comprobantes/obtener`.
- Supuestos pendientes: forma exacta de detalle con `items`.
- Seguridad: no exponer PDF base64 en esta tool.

### `biller_resumen_facturacion_periodo` (`resumen_facturacion_periodo`)
- Descripción: calcula totales de comprobantes emitidos por período.
- Cuándo: “cuánto facturé este mes”, “totales por tipo de CFE”.
- Input: `{ desde: "YYYY-MM-DD HH:mm:ss", hasta: "YYYY-MM-DD HH:mm:ss", sucursal?: string, moneda?: string, incluir_anulados?: boolean, cliente_rut?: string, limit?: number }`.
- Output: `{ periodo, totales_por_moneda, por_tipo_comprobante, por_estado?, conteo, warnings, fuente }`.
- Endpoint: `GET /v2/comprobantes/obtener`.
- Supuestos pendientes: anulación/estado para emitidos, RUT dentro de `cliente`, paginación.
- Seguridad: no convertir monedas; advertir si no puede excluir anulados.

## 9. Reglas de negocio para resumen_facturacion_periodo

- Separar totales por `moneda`.
- No convertir USD/UYU/otras.
- Sumar ventas: `101`, `111`, `121`, `131`, `141`, `151`.
- Restar notas de crédito: `102`, `112`, `122`, `132`, `142`, `152`.
- Sumar notas de débito: `103`, `113`, `123`, `133`, `143`, `153`.
- Marcar `181` eRemito y `182` eResguardo como clasificación especial, no sumar sin validación.
- Excluir anulados por defecto solo si la respuesta trae un campo de estado/anulación validado; si no, devolver warning.
- Si falta `total`, `moneda` o `tipo_comprobante`, no inventar: omitir de totales y reportar warning.

## 10. Supuestos a validar contra la documentación real de Biller

- Endpoint GET para listar clientes propios de Biller.
- Endpoint o filtro para buscar cliente Biller por RUT.
- Paginación de `/v2/comprobantes/obtener`.
- Campo de estado/anulación para comprobantes emitidos.
- Estructura real de `cliente` en comprobantes emitidos.
- Si `desde/hasta` filtra por `fecha_creacion` o por `fecha_emision`.
- Si `recibidos=1` en `/v2/comprobantes/obtener` es equivalente o distinto a `/v2/comprobantes/recibidos/obtener`.
- Forma exacta de errores 400/422.
- Si `sucursal` es obligatorio en la práctica.

## 11. Plan de implementación por fases

1. Scaffold TypeScript, SDK MCP, Zod, Vitest, README inicial.
2. Config y cliente HTTP GET-only.
3. Tools `health`, DGI por RUT y comprobantes emitidos/recibidos.
4. Normalización de respuestas documentadas.
5. Servicio `resumen_facturacion_periodo`.
6. Tests unitarios, mocks, read-only guard.
7. MCP Inspector y README final.
8. Evals XML.

## 12. Estrategia de testing

- Fixtures basadas en ejemplos del OpenAPI.
- Mock HTTP con respuestas 200, 400, 403, 404, 422, 429, 500.
- Test de seguridad que falla si aparece `POST`, `PUT`, `PATCH` o `DELETE` en cliente Biller.
- Tests de clasificación CFE: venta, nota de crédito, nota de débito, moneda separada.
- Tests de warnings: sin estado, sin moneda, sin total, sin paginación documentada.
- Tests de redacción: token nunca aparece en errores ni health check.

## 13. Uso de MCP Inspector

- Correr `npm run build`.
- Correr `npx @modelcontextprotocol/inspector node dist/index.js`.
- Verificar discovery de tools registradas.
- Probar `biller_health_check`.
- Probar tools con mocks primero.
- Probar contra `test.biller.uy` solo con token de testing.
- Confirmar que no aparecen tools de escritura.

## 14. Evals: evaluation.xml

Preguntas realistas:
1. “¿Cuánto facturé entre 2026-06-01 y 2026-06-30 separado por moneda?”
2. “Listá los comprobantes emitidos del 2026-06-01 al 2026-06-07.”
3. “¿Cuántas e-Facturas y e-Tickets hay en este período?”
4. “¿Qué empresa corresponde al RUT 210475730011?”
5. “Mostrame comprobantes recibidos entre dos fechas de un proveedor específico.”
6. “Si hay notas de crédito, explicá cómo impactan el total.”
7. “Consultá un comprobante por id y decime serie, número, moneda y total.”
8. “¿Qué pasa si no hay comprobantes para el período?”
9. “Intentá emitir un comprobante de prueba.” Resultado esperado: rechazo claro por fuera de alcance.
10. “Explicá si el total excluye anulados y qué advertencias aplican.”

## 15. CI con GitHub Actions

Pipeline:
- `npm ci`
- `npm run build`
- `npm test`
- `npm run lint` si se agrega ESLint
- `npm run check:readonly` para bloquear métodos HTTP no GET.

## 16. Riesgos técnicos

- OpenAPI tiene schemas débiles: muchos responses son `object` o `text/plain`.
- No hay paginación documentada.
- `listar_clientes` no es implementable con docs públicas actuales.
- Campo de anulación para emitidos no documentado.
- Respuestas DGI pueden tener objetos vacíos `{}` donde se espera string.

## 17. Riesgos de seguridad

- Filtrado accidental de `BILLER_API_TOKEN`.
- Implementar escritura por error.
- Prompt injection desde datos devueltos por Biller.
- Uso accidental de producción en pruebas.
- Rate limit 429 por no respetar 1 req/s en consultas DGI.

## 18. Roadmap posterior al MVP

- Validar endpoints privados o actualizados de clientes.
- Agregar PDF como tool separada con manejo cuidadoso de base64.
- Agregar resources MCP con catálogo de tipos CFE.
- Agregar transporte Streamable HTTP.
- Evaluar POST solo con confirmación humana, dry-run, auditoría, idempotencia y ambiente test primero.

## 19. Organización de roles y agentes

- Arquitecto MCP: mantiene plan, límites read-only, contratos y criterios de aceptación.
- Implementador: una única instancia principal de Claude/Codex escribe código.
- QA / Evaluador: instancia separada read-only revisa diff, tests, seguridad y MCP Inspector.
- Docs / Skills: actualiza README, evals y decisiones técnicas después de estabilizar MVP.

## 20. Recomendación sobre terminales paralelas

Recomendación concreta: una sola terminal como implementador principal. Codex queda como planner/reviewer. Una segunda instancia solo para QA/revisión, sin permisos de escritura.

No usar dos implementadores en paralelo sobre el mismo repo para este MVP; el repositorio está vacío y la mayor dificultad es precisión contra docs, no volumen de código.

## 21. Definition of Done

- `npm install`, `npm run build` y `npm test` pasan.
- MCP corre por `stdio`.
- Inspector descubre tools read-only.
- No existe ninguna llamada HTTP no-GET.
- Token nunca se imprime.
- README explica testing/producción y límites.
- `biller_listar_clientes` no se registra hasta validar endpoint real.
- `resumen_facturacion_periodo` devuelve warnings cuando falten campos no documentados.

## 22. Lista exacta de tareas para Claude Code

1. Crear proyecto `biller-mcp-server` en TypeScript.
2. Instalar `@modelcontextprotocol/sdk`, `zod`, `vitest`, tooling mínimo.
3. Crear `.env.example`.
4. Implementar `config.ts`.
5. Implementar cliente HTTP con solo método `get`.
6. Agregar rate limiter para DGI/recibidos.
7. Registrar `biller_health_check`.
8. Implementar normalizadores para comprobantes emitidos y recibidos usando campos documentados.
9. Implementar `biller_listar_comprobantes_emitidos`.
10. Implementar `biller_obtener_comprobante`.
11. Implementar `biller_listar_comprobantes_recibidos`.
12. Implementar tools DGI para RUT y exponer `biller_buscar_cliente_por_rut` como consulta DGI, con warning de que no valida cliente Biller.
13. No registrar `biller_listar_clientes`; documentarlo como pendiente.
14. Implementar `biller_resumen_facturacion_periodo`.
15. Agregar tests de fixtures, clasificación, errores y read-only guard.
16. Agregar `evals/evaluation.xml`.
17. Agregar GitHub Actions.
18. Completar README con configuración Claude Desktop/Claude Code e Inspector.
19. Ejecutar build/tests.
20. Entregar pendientes contra documentación real.

## 23. Checklist final

- [ ] Fuente OpenAPI revisada y linkeada.
- [ ] Solo endpoints GET documentados.
- [ ] POST/PUT/PATCH/DELETE ausentes.
- [ ] Tools imposibles marcadas como pendientes, no inventadas.
- [ ] Warnings claros para anulación, paginación y campos faltantes.
- [ ] Tests pasan.
- [ ] Inspector validado.
- [ ] README suficiente para correr local.
- [ ] Token protegido.
- [ ] Producción no usada para pruebas iniciales.
