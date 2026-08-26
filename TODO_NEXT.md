# TODO_NEXT

Cosas pendientes para la siguiente iteración, ordenadas por prioridad.

Lo que ya está hecho queda marcado `[x]` con el archivo donde vive, en vez de
borrarse: saber qué se resolvió y dónde vale más que una lista corta.

## P0 — Antes de poner en producción

- [ ] **Validar endpoints de escritura contra la API real de test.**
  Los schemas de los POST en el OpenAPI solo traen ejemplos, no schemas estrictos.
  Hacer una emisión real en `test.biller.uy` con `biller_emitir_comprobante`
  (dry-run → confirm) y confirmar que Biller acepta el payload.
  Idem para `biller_crear_cliente`, `biller_crear_recibo`, etc.
  Parcial: los preview salieron contra el server real (dry-run, 28/07) y de ahí
  salieron hallazgos que contradicen al OpenAPI —`direccion`/`ciudad`
  obligatorias, 422 por `numero_interno` inexistente— anotados en
  [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) §7. Falta el `confirm` real.

- [ ] **Confirmar soporte server-side del header `Idempotency-Key`.**
  El MCP envía el header pero no hay garantía de que Biller lo procese.
  Actualmente la idempotencia es in-process (in-memory por sesión).
  Si el servidor Biller lo soporta, la protección se extiende entre sesiones.

- [ ] **Publicar como npm package o binario.**
  Cambiar `private: true` en `package.json` cuando se quiera distribuir.
  Agregar `README` con instrucciones de instalación global (`npm i -g biller-mcp`).

## P1 — Mejoras prioritarias

- [x] **Tool de PDF** (`GET /v2/comprobantes/pdf`) — hecha: `biller_obtener_pdf`
  en `src/tools/obtenerPdf.ts`. También es la que alimenta el documento adjunto
  de WhatsApp (subida multipart a Kapso + `media_id`).

- [ ] **Validar paginación.** `pagination_supported: false` es conservador.
  Confirmar con Biller si `/v2/comprobantes/obtener` pagina y con qué parámetros.
  Si hay paginación nativa, el `limit` local pasa a ser innecesario.

- [ ] **`biller_listar_clientes`** — pendiente de endpoint GET documentado.
  Vive declarada en `PENDING_TOOLS` (`src/tools/register.ts`) justamente para que
  "no registrada" sea una decisión visible y no un olvido. Cuando Biller documente
  el GET de clientes propios, agregarla con el patrón de las otras de lectura.

- [ ] **Filtros nativos de moneda/cliente en emitidos.**
  Confirmar si la API acepta `moneda` o `rut_receptor` como query params;
  si es así, el filtro local pasa a ser secundario (post-filter para compatibilidad).

## P2 — Robustez y observabilidad

- [x] **Audit log persistente entre sesiones.** Hecho: `FileIdempotencyStore`
  (append-only en disco, `BILLER_IDEMPOTENCY_LOG_PATH`) en
  `src/write/idempotency.ts`, y el audit log en `src/write/audit.ts`
  (`BILLER_AUDIT_LOG_PATH`). El archivo guarda key + timestamp, nunca el payload.
  Ojo: en serverless el disco no sobrevive — ver `src/transport/serverless.ts`.

- [ ] **Rate-limit configurable por env.**
  Los límites actuales (1 req/seg DGI, 30 req/seg resto) están hardcodeados en
  `src/utils/rateLimit.ts`. Podrían exponerse como variables opcionales.

- [x] **Transporte Streamable HTTP** (además de stdio). Hecho:
  `src/transport/http.ts` (sesiones + Bearer propio `BILLER_HTTP_AUTH_TOKEN`,
  `/healthz` sin auth) y `src/transport/serverless.ts` para el despliegue sin
  proceso largo. Es el transporte por el que entra el Agent Node de Kapso.

- [ ] **Resource MCP con catálogo de tipos de CFE.** Sigue pendiente como
  *resource*: no hay ni un `registerResource` en `src/`. Lo que sí existe son dos
  tools que responden lo mismo sin pegarle a la API (`biller_catalogo_datos`,
  `biller_requisitos_comprobante`), así que el valor que queda es el de la forma
  —un resource se cachea del lado del cliente—, no el del dato.

- [ ] **Tests de integración contra `test.biller.uy`** (ci opcional).
  Un suite separado con token real y `process.env.CI_INTEGRATION=true` que
  verifique los endpoints reales. No correr en cada PR, solo manualmente.

## P3 — Deuda técnica conocida

- [x] **Campo `estado` en emitidos** — sí viene en el GET y ya se usa:
  `src/biller/normalize.ts` lo mapea y `solo_aceptados` (default `true`) cuenta
  solo "Aceptado DGI", que es el criterio con el que Biller arma sus totales.
  Queda abierto lo otro: no hay un campo de **anulación**, así que una venta
  anulada por NC se descuenta por el signo negativo de la nota, no por estado.

- [x] **Estructura de `cliente` en emitidos** — normalizado: `extractFromCliente`
  en `src/biller/normalize.ts` tolera las dos formas (`[]` y objeto), así que el
  filtro `cliente_rut` ya no depende de cuál mande la API.

- [ ] **`defaultSucursalId` en tools de escritura** — aplicado en `emitirComprobante`,
  pendiente de evaluar si aplica también a `crearRecibo`. (Verificado: en las
  tools de lectura el fallback `a.sucursal ?? config.defaultSucursalId` está en
  todas; en `src/tools/write/` no.)
