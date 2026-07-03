# TODO_NEXT

Cosas pendientes para la siguiente iteración, ordenadas por prioridad.

## P0 — Antes de poner en producción

- [ ] **Validar endpoints de escritura contra la API real de test.**
  Los schemas de los POST en el OpenAPI solo traen ejemplos, no schemas estrictos.
  Hacer una emisión real en `test.biller.uy` con `biller_emitir_comprobante`
  (dry-run → confirm) y confirmar que Biller acepta el payload.
  Idem para `biller_crear_cliente`, `biller_crear_recibo`, etc.

- [ ] **Confirmar soporte server-side del header `Idempotency-Key`.**
  El MCP envía el header pero no hay garantía de que Biller lo procese.
  Actualmente la idempotencia es in-process (in-memory por sesión).
  Si el servidor Biller lo soporta, la protección se extiende entre sesiones.

- [ ] **Publicar como npm package o binario.**
  Cambiar `private: true` en `package.json` cuando se quiera distribuir.
  Agregar `README` con instrucciones de instalación global (`npm i -g biller-mcp`).

## P1 — Mejoras prioritarias

- [ ] **Tool de PDF** (`GET /v2/comprobantes/pdf`) — devolver base64 como resource MCP.
  Útil para descargar/previsualizar un comprobante emitido directamente desde Claude.

- [ ] **Validar paginación.** `pagination_supported: false` es conservador.
  Confirmar con Biller si `/v2/comprobantes/obtener` pagina y con qué parámetros.
  Si hay paginación nativa, el `limit` local pasa a ser innecesario.

- [ ] **`biller_listar_clientes`** — pendiente de endpoint GET documentado.
  Cuando Biller documente un endpoint GET de clientes propios, agregar la tool
  siguiendo el mismo patrón que las otras de lectura.

- [ ] **Filtros nativos de moneda/cliente en emitidos.**
  Confirmar si la API acepta `moneda` o `rut_receptor` como query params;
  si es así, el filtro local pasa a ser secundario (post-filter para compatibilidad).

## P2 — Robustez y observabilidad

- [ ] **Audit log persistente entre sesiones.**
  Actualmente el `IdempotencyStore` es in-memory. Para producción se puede
  serializar el store a disco (mismo archivo que `BILLER_AUDIT_LOG_PATH`).

- [ ] **Rate-limit configurable por env.**
  Los límites actuales (1 req/seg DGI, 30 req/seg resto) están hardcodeados en
  `src/utils/rateLimit.ts`. Podrían exponerse como variables opcionales.

- [ ] **Transporte Streamable HTTP** (además de stdio).
  Permite desplegar el MCP como servicio HTTP para integraciones sin subprocess.

- [ ] **Resource MCP con catálogo de tipos de CFE.**
  Exponer la tabla de tipos (101 e-Ticket, 111 e-Factura, etc.) como un resource
  para que el asistente pueda consultarla sin hacer una llamada a la API.

- [ ] **Tests de integración contra `test.biller.uy`** (ci opcional).
  Un suite separado con token real y `process.env.CI_INTEGRATION=true` que
  verifique los endpoints reales. No correr en cada PR, solo manualmente.

## P3 — Deuda técnica conocida

- [ ] **Campo `estado`/`anulacion` en emitidos** — Biller no lo expone en el GET.
  El `resumen_facturacion_periodo` no puede excluir anulados confiablemente.
  Warning documentado; resolver cuando Biller agregue el campo.

- [ ] **Estructura de `cliente` en emitidos** — a veces `[]`, a veces objeto.
  El filtro `cliente_rut` falla silenciosamente si la estructura cambia.
  Normalizar cuando se confirme la forma estable.

- [ ] **`defaultSucursalId` en tools de escritura** — aplicado en `emitirComprobante`,
  pendiente de evaluar si aplica también a `crearRecibo`.
