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

- [ ] **Webhook de Kapso multi-empresa.** `atenderWebhook`
  (`src/transport/http.ts`) usa la config **del proceso**: el capability mode y
  la allowlist de remitentes con los que decide son los de la empresa de las
  variables de arriba, no los de la empresa a la que le escribieron. En un
  despliegue con varios números eso es la barrera de entrada de A validando un
  mensaje dirigido a B. El dato para resolverlo ya llega: el `phone_number_id`
  del receptor viene en `value.metadata` del evento de Kapso, y `normalizarEvento`
  (`src/kapso/webhook.ts`) lo **descarta**. Falta leerlo, mapearlo al tenant por
  su `KAPSO_PHONE_NUMBER_ID` y atender con el contexto de esa empresa —y decidir
  qué hacer con un `phone_number_id` que no mapea a ninguna, que tiene que ser
  ignorar, no caer al proceso.

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
  Ampliado en agosto de 2026: las sesiones ya no viven para siempre. `RegistroSesiones`
  (mismo archivo) les pone TTL de 30 min sin uso y techo de 200 con LRU, y al
  desalojar **cierra** el transporte —sacarlo del mapa sin cerrarlo es la misma
  fuga con el contador bajando—. Antes solo se soltaban con el cierre limpio del
  cliente, así que cada túnel cortado dejaba un transporte y un `McpServer` vivos
  para siempre.

- [x] **Aislamiento entre empresas del overlay de tenants.** Hecho:
  `src/tenants/registry.ts`. Lo que un tenant no declara ya no se hereda en
  silencio: lo sensible se **borra** (`VARIABLES_QUE_NO_SE_HEREDAN`), las rutas
  de persistencia y los topes `BILLER_MAX_MONTO_*` son **fatales al arrancar** si
  el proceso los define y el tenant no, y `BILLER_API_TOKEN` o un archivo de
  persistencia repetidos entre tenants tampoco arrancan. Alrededor: el health
  check reporta la config del tenant y degrada sin remitente verificado
  (`src/tools/health.ts` + `ToolContext.inspeccionar` en `src/tools/shared.ts`), la
  barrera de entrada inyecta el remitente verificado en el input
  (`src/security/entrada.ts`) y el borrador de emisión se ata a él
  (`identidadDeConversacion` en `src/security/remitentes.ts`). El presupuesto del
  cache es por empresa (`src/biller/cacheVentanas.ts`) y la línea de log de
  métricas lleva `empresa` (`src/observabilidad/metricas.ts`).

- [ ] **Llevar a `config.ts` lo que hoy se lee suelto del entorno.** Dos cosas
  quedaron leyéndose con un helper local en `src/transport/http.ts`
  (`BILLER_HTTP_SESSION_TTL_MS`, `BILLER_HTTP_MAX_SESSIONS`), fuera de la
  configuración validada y por lo tanto fuera del overlay de tenants. Hoy no
  duele —son parámetros del proceso, no de una empresa—, pero es el mismo camino
  por el que `BILLER_CACHE_ENABLED` se volvió la única variable imposible de
  pisar.

- [ ] **Enchufar la habilitación de cache por empresa.**
  `registrarHabilitacionCache` (`src/services/periodo.ts`) está exportada y
  **nadie la llama**: el mecanismo quedó listo y el comportamiento de hoy
  intacto, o sea que `BILLER_CACHE_ENABLED` sigue siendo del proceso. Falta que
  quien arma el registro de tenants la registre resolviendo por `cacheId`.
  Mientras tanto, apagar el cache para diagnosticar un total que no cierra en una
  empresa lo apaga para las veinte.

- [ ] **Derivar las rutas de persistencia de un `BILLER_DATA_DIR` + `tenant.id`.**
  Hoy cada tenant tiene que declarar las tres a mano (`BILLER_AUDIT_LOG_PATH`,
  `BILLER_IDEMPOTENCY_LOG_PATH`, `BILLER_BORRADOR_STORE_PATH`) y el registro se
  limita a verificar que no falten ni se repitan. Con un directorio base y el id
  del tenant, el caso correcto sale solo y la validación pasa a ser la red y no
  la única defensa: ahora mismo, dar de alta una empresa son tres rutas que
  alguien escribe a mano y una de ellas se puede copiar de la entrada de arriba.

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
