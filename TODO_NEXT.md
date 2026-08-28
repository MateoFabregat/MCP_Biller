# TODO_NEXT

Cosas pendientes para la siguiente iteración, ordenadas por prioridad.

Lo que ya está hecho queda marcado `[x]` con el archivo donde vive, en vez de
borrarse: saber qué se resolvió y dónde vale más que una lista corta.

## Auditoría integral (agosto 2026) — cuatro revisiones en paralelo

Seguridad, fiscal, arquitectura (CTO) y capa conversacional revisaron todo el
repo, cada hallazgo verificado ejecutando código. Lo que se arregló en esta
tanda está marcado; lo que queda tiene repro y prioridad. El resto de este
archivo son los backlogs previos, todavía válidos.

### Ya arreglado en esta tanda

- [x] **Los fixtures de fecha se anclaban a UTC → la suite fallaba 4 tests todas
  las noches (21:00–00:00 UY).** Anclados a `hoyComoDateUy()` en
  `tests/{recordatorioCobro,certificadoDgi,alertas}.test.ts`. Verificado con la
  suite bajo `TZ=UTC`. (commit `fix(tests): los fixtures de fecha…`)
- [x] **CRÍTICO fiscal: el punto de miles convertía un precio de emisión en su
  centésima** (`"6.500"` → 6.5, un CFE de $6,50 donde iba $6.500). Nuevo
  `plata()` en `src/biller/coerce.ts`, aplicado a los campos de importe/cantidad
  de `cfeSchema` y `operacionesSchema`. Era **bloqueante de publicación**.
- [x] **Seguridad: la envoltura `⟦dato-no-confiable⟧` era case-sensitive** y DGI
  devuelve claves en PascalCase (`Denominacion`). Comparación en minúsculas.
- [x] **Seguridad: `npx ... init` ecoaba el token** al pegarlo. Muteado.
- [x] **Seguridad: token y datos comerciales en disco con 0644.** Ahora 0600/0700.

### P0 de seguridad — falta (alta severidad, commit propio)

- [ ] **El canal de ERROR saltea la envoltura de datos no confiables.** ALTA.
  `sanitizeToolResult` (`src/security/sanitize.ts`) solo envuelve
  `structuredContent`; un error no lo tiene, así que solo corre `redactSecrets`.
  `BillerApiError.toSafe()` (`src/utils/errors.ts:165`) devuelve `details` con
  hasta 600 chars del cuerpo crudo de Biller, y `parseValidationBody` mete el
  texto del 422 dentro de `message`. Vector: un proveedor hostil pone una
  inyección en el `concepto` de un CFE; una consulta que dé 422/500 (los 500 son
  "normales" en Biller) devuelve ese texto **crudo** al modelo, en la misma
  conversación donde se le prometió que todo lo de terceros vendría marcado.
  Los dos sub-vectores (`message` embebido y `details` crudo) NO se cubren por
  clave: el fix es envolver el bloque de error de Biller como no-confiable de
  punta a punta, en `toSafe()` o en `sanitizeToolResult` cuando `structured`
  es undefined. Decisión de diseño antes de código.

### P0 fiscal — falta (cada uno mueve un número, commit propio)

- [ ] **`biller_recordatorio_cobro` no ata el `confirmation_token` a la
  identidad** (`src/tools/recordatorioCobro.ts:273,300`): llama a
  `computeConfirmationToken`/`checkConfirmationToken` sin el 5º argumento, a
  diferencia de `tools/write/shared.ts`. Intra-empresa, otro usuario podría
  confirmar un envío que no previsualizó. Exportar `identidadDeEscritura`.
- [ ] **NC recibida suma IVA compras en vez de restarlo.** `posicionIva.ts:166`
  y `proveedores.ts` no miran `r.tipo`: una compra anulada por el proveedor
  infla el crédito fiscal. **Antes de codear: confirmar con `npm run contrato`
  si Biller devuelve `total_iva` negativo en las NC recibidas** — si ya viene
  negativo, el fix es el opuesto. No tocar a ciegas.
- [ ] **La NC que sugiere `biller_plan_anulacion` va siempre a 22%.**
  `anulacion.ts:257`, `indicador_facturacion: 3` hardcodeado. Anular una factura
  de tasa mínima (10%) sobreacredita IVA. Derivar el indicador del desglose del
  original; si hay mezcla de tasas, no sugerir cuerpo.
- [ ] **El aviso "receptor obligatorio" no llega al resumen que aprueba el
  humano.** Nace en `cfeSchema.ts:636` (`validarComprobante`) y va solo a
  `structuredContent.warnings` (el modelo), no al resumen de WhatsApp
  (`render.ts` / `formatearTotales`). La regla de DGI "que más caro sale" viaja
  por el canal que el proyecto declaró no confiable. Pasar los warnings
  bloqueantes fiscales a `advertenciasDelPreview` (`calcularTotales.ts:576`),
  arriba de todo.

### P0/P1 conversacional — falta (repro confirmado; fixes con archivo:línea)

- [ ] **Línea a $0/negativa al final deja el flujo mudo.** Darle interactivo a
  la rama `precio` cuando el ítem ya tiene un número ≤0 (`emision.ts:1622`), con
  botones "dejarlo" / "sacar la línea". Cambia un test pineado a propósito.
- [ ] **`precio_copiado` sobrevive a `items` explícitos** → línea a $0 emitida en
  silencio. `borradorStore.ts:248`: `if (nuevo.precio !== undefined) delete
  item.precio_copiado`. **Este mueve un número**, no es cosmético.
- [ ] **Un producto queda como razón social en el paso `cliente`**
  ("coca 2 litros" → `razon_social: "coca"`). `extraerPedido.ts` + guarda en
  `borradorEmision.ts:308` para lectura posicional vs. explícita. Mueve un dato
  del CFE.
- [ ] **`calidad()` del enrutador empata exacto con inclusión**
  (`enrutador.ts:735`): en `read_only`, "me equivoqué con el recibo" cae en
  `menu:anular` (una NC por un recibo). Puntuar exacto=3, inclusión=2, aprox=1.
- [ ] **Ecos crudos**: `$-200` en pregunta/botón (`emision.ts:1577`), precios
  huérfanos sin formatear (`borradorEmision.ts:423`). Usar el helper `importe()`.
- [ ] **`SKILL.md` §fechas**: dice pasar fechas concretas; debe decir usar los
  **alias simbólicos** (`hoy`, `mes_actual`…) que el server resuelve en hora UY.
  Si el modelo calcula la fecha, contesta cero después de las 21:00.
- [ ] **`SKILL.md`**: cubre 16 de 27 tools; afirma "esta instalación es de solo
  lectura" (falso en `write_enabled`) y niega `biller_plan_anulacion` (que
  funciona en read_only); falta el matiz de monedas (nunca sumar UYU+USD).
- [ ] **Corpus de evals**: 29 casos nuevos propuestos (jerga de mostrador,
  "ayer", singulares, vencimientos). Meterlos JUNTO con los fixes de sinónimos o
  el gate `--min 95` frena el commit. Archivo en el scratchpad de la sesión.
- [ ] **Texto**: el encabezado del menú muestra el RUT donde va el nombre
  (`render.ts:37` recibe `defaultEmpresaRut`); "CFE"/"ambiente"/"servidor" son
  jerga; "una de estas dos cosas" con 3 candidatas (`render.ts:66`).

### Arquitectura / deuda (CTO) — falta

- [ ] **`CacheDetalles` comparte presupuesto entre empresas**
  (`src/biller/traerDetalles.ts`): mismo bug ya arreglado en `cacheVentanas.ts`
  (mapa único + FIFO en vez de LRU por empresa), en el cache más caro (391ms/miss).
  Erosión del invariante 4. El arreglo está escrito al lado: portarlo.
- [ ] **Zod v4 NO borra `transport/dialecto.ts`** (verificado contra el SDK
  1.29.0: llama a `toJsonSchemaCompat` sin `target`), y `inlinearRefs` no depende
  del dialecto. Corregir `README.md:677`, `docs/EQUIPO.md:100,254` que prometen
  lo contrario. El canario de `tests/dialecto.test.ts` es la única condición de
  retiro.
- [ ] **Publicar en npm**: falta `npm publish` + `LICENSE` (MIT declarada, sin
  archivo). El README manda `npx biller-mcp-server` que da 404. Nombre libre.
- [ ] **`.env.example` dice "6 tools"** (son 27+7) y no está bajo el guard de
  `conteosDoc`. Sumarlo. El conteo de tests en docs (1050/1376) también divergió.
- [ ] **Alta plug-and-play** (ver el plan en la respuesta de la sesión): fase 1
  `onboard --crear` que deriva RUT/sucursal de la API; fase 2 recarga en caliente
  del registro (hoy dar de alta una empresa = reiniciar todas); fase 3 formulario.
- [ ] **Pista 2 (remoto + OAuth)**: Resource Server contra un IdP de tercero con
  DCR (no construir Authorization Server propio). Reusa `autenticarConTenants`
  como segunda rama. Escritura remota queda para el final (no hay `remitente`
  verificado: falta un equivalente al ancla de `identidadDeConversacion`).
- [ ] **Extender el guard `fechaUyGuard` a `tests/`** con patrones de fixture y
  allowlist para tokens/timestamps. Hoy solo barre `src/`.
- [ ] **Partir `handleEmisionGuiada`** (555 líneas en una función) y sacar los 11
  `construirSubmenu*` de `emision.ts` a `render.ts`. Por diferencial contra el
  corpus.

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

## P0 — Hallazgos fiscales sin resolver (encontrados agosto 2026, NO tocados)

Los dos salieron de la ola de refactors y ninguno se arregló ahí a propósito:
mezclar un arreglo de conducta con un refactor de diferencial cero hace
imposible saber qué movió qué. Los dos terminan en un número o un texto
equivocado en un documento fiscal.

- [x] **El resumen y los rankings pueden contestar totales distintos para los
  mismos comprobantes.** RESUELTO (agosto 2026): quedó UNA sola
  `clasificarEstado`, en `src/services/estadoDgi.ts`, y el criterio de qué suma
  vive en `estaAceptado` del mismo archivo — solo "Aceptado DGI", el estado
  desconocido tampoco cuenta. Cambió el resumen (los rankings ya usaban ese
  criterio) y también `cobrado_por_moneda`, que ahora filtra igual que el total.
  La exclusión se avisa en el resumen (cuántos y cuánto sumaban), en los
  rankings de clientes, sucursales y productos —en los dos primeros el warning
  decía "se contaron igual" y era falso; el de productos no existía—, en la
  comparación de períodos, en las cohortes y en la posición de IVA. El aviso del
  resumen lleva el monto separado en lo que sumaba y lo que restaba, porque una
  nota de crédito excluida no deja el total corto sino INFLADO. De paso quedó
  explícito en `alertas.ts` que un estado ausente no se alerta pero un texto
  irreconocible SÍ (una redacción nueva de rechazo tiene que verse igual). Lo
  fija `tests/estadoDgi.test.ts`, incluido un test que falla si vuelve a haber
  dos `clasificarEstado`. Sigue abierto el punto de abajo.
  Descripción original del bug, para el contexto:
  `src/services/resumenFacturacion.ts:167` y `src/services/estadoDgi.ts:49`. El
  resumen excluye solo lo que sabe rechazado (`=== "no_aceptado"`) y **cuenta el
  estado desconocido**, con el argumento escrito de que "la ausencia del dato no
  es evidencia de rechazo". Las otras siete implementaciones —rankings,
  comparación, cohortes, posición IVA, y la regla unificada de
  `comprobanteFilters`— filtran con `!== "aceptado"` y **lo excluyen**. Un
  comprobante con `estado: null` suma en un lado y no en el otro. Falta la
  decisión: el criterio fijado es contar solo "Aceptado DGI" para coincidir con
  lo que muestra Biller, lo que da la razón a los rankings, pero si el `null`
  viene de un problema de la API y no del comprobante, excluirlo da un total
  bajo sin motivo. Decidir y unificar en un commit propio, con el diferencial
  que muestre qué comprobantes cambian de lado.
- [ ] **"Envío no corresponde" no cuenta en ningún total, y probablemente
  debería.** `esVentaValida` (`src/services/estadoDgi.ts`) sostiene que es una
  venta real y facturada, y que excluirla porque no viajó individualmente a DGI
  es confundir el canal de reporte con la validez del documento. Ningún total le
  hace caso: todos usan `estaAceptado`, que compara contra "Aceptado DGI" a
  secas. Se dejó así a propósito en la unificación de criterios de agosto de
  2026 —cambiar dos criterios fiscales en el mismo commit hace imposible saber
  cuál movió qué número— y la diferencia está pineada en
  `tests/estadoDgi.test.ts`. Lo que hay que medir antes de decidir: en un
  comercio de tickets chicos, los e-Ticket por debajo de 5.000 UI quedan en ese
  estado, así que contarlos puede mover el total de casi toda la facturación, y
  hay que confirmar contra el panel de Biller si Biller los cuenta o no.

- [x] **Un ítem incompleto en el MEDIO le corría los conceptos a las demás
  líneas.** Resuelto en agosto de 2026. `siguientePaso` miraba solo el ÚLTIMO
  ítem, así que con `[{A,100},{B sin precio},{C,300}]` decía `confirmar`, el
  borrador salía con dos líneas y el agente —al que `completar` le pide los
  conceptos "en el mismo orden en que la dijo"— le ponía el concepto B a la
  línea de C: un concepto equivocado en una línea de un CFE real.
  Ahora el ítem en curso es el PRIMERO que falta (`itemsVigentes` +
  `indiceItemEnCurso`, `src/kapso/emision.ts`), el borrador CORTA en el primer
  ítem que no puede viajar en vez de saltearlo (`src/kapso/borradorEmision.ts`)
  —así lo que se entrega es siempre un PREFIJO, que es la propiedad de la que
  depende `completarDesdeSesion` para rellenar por posición— y el invariante
  está verificado por fuerza bruta, no declarado.
  De la misma tanda salieron cuatro cosas que no estaban en el pedido: el IVA de
  una línea negativa se descartaba (`calcularTotales` acumulaba el neto sin
  guarda y el IVA detrás de `iva > 0`, así que el preview inflaba el total), una
  respuesta de texto aterrizaba en el ítem equivocado (`rellenarDesdePedido`
  indexaba por el ítem del MENSAJE y no por el ítem en curso: "sumale 3 tortas a
  450" pegaba el 3 en la línea de arriba y dejaba un cliente llamado "sumale"),
  dos productos que comparten una palabra se mezclaban ("3 agua mineral a 60"
  sobre "Agua tónica"), y `repetir_ultima_de` sobre una factura con una línea
  bonificada trancaba el flujo.

## P0 — Lo que quedó abierto de esa tanda (ninguno mueve un número por sí solo)

Salieron de la quinta revisión fiscal. Se anotan en vez de arreglarse porque
ninguno produce un importe equivocado: trancan el flujo o ecoan feo. El repro de
cada uno está acá para no tener que volver a encontrarlo.

- [ ] **Una línea a $0 o negativa AL FINAL, mandada por el agente, tranca el
  flujo.** Con `items: [{Venta,1,"1.000"},{Descuento,1,"-200"}]` el paso queda en
  `precio`, sin botones, y NO sale con nada: reenviar el precio,
  `emision:item:listo`, `items_cerrados:true`, el texto "listo", el texto "-200"
  y `emision:item:cancelar` devuelven los siete la misma pregunta. Es
  preexistente —`itemIncompleto` exige precio positivo—, y el escape que se
  agregó (`precio_copiado`) cubre solo el camino de `repetir_ultima_de`. Ojo:
  hoy está PINEADO como conducta buscada en `tests/emisionGuiada.test.ts` ("del
  ÚLTIMO sí se sigue preguntando el precio"), así que arreglarlo es cambiar ese
  test a propósito.

- [ ] **`precio_copiado` no se pierde con `items` explícitos, al revés de lo que
  promete su propio contrato.** El comentario de `src/kapso/emision.ts` dice que
  si el agente reenvía `items` la marca se pierde y el flujo vuelve a preguntar;
  `fusionarItems` (`src/kapso/borradorStore.ts`) fusiona campo por campo y la
  marca sobrevive. Resultado: una línea a $0 aceptada en silencio, con
  `warnings: []`. Corrección: si `encima[i].precio !== undefined`, borrar
  `precio_copiado`.

- [ ] **En el paso `cliente`, un producto queda como razón social.** Con
  `clase_receptor: "consumidor_final"`, sin `sin_receptor` y sin ítems,
  "coca 2 litros" deja `nombre_cliente: "coca"` e `items[0].concepto: "litros"`,
  y `completar` le ordena al agente ponerlo en `cliente.razon_social`. Es la pata
  que quedó de la guarda de etapa; la de `sin_receptor` sí está cerrada.

- [ ] **`$-200` en la pregunta y en el botón de descarte.** Con una línea sin
  descripción y precio negativo sale "Me falta saber qué era la línea de $-200" y
  `🗑️ Sacar $-200`. Es la convención que la misma entrega prohibió y testeó en
  `calcularTotales` (`not.toContain("$-")`). Usar el mismo helper.

- [ ] **Los precios huérfanos se ecoan crudos.** `src/kapso/borradorEmision.ts`
  arma el aviso con `descartados.join(", ")`, así que $6.500 sale como "(6500)".
  El mismo changeset escribió que "un eco escrito '5000' en un país que escribe
  '5.000' es un eco que el usuario no puede verificar".

- [ ] **Sobreconteo cosmético en los avisos de estado.** `cohortes.ts` y
  `comparacion.ts` incrementan `sinEstado` ANTES del filtro de `total`/`moneda`
  nulos, así que el aviso puede nombrar comprobantes que igual quedaban afuera
  por otro motivo. No mueve ningún total.

## P1 — Mejoras prioritarias

- [ ] **El texto crudo no contesta las preguntas de `concepto` ni de `precio`.**
  `interpretarRespuestaLibre` (`src/kapso/emision.ts`) entiende las respuestas de
  los pasos con botones —receptor, cliente, moneda, IVA, fecha, tasa de cambio—
  y para `concepto` y `precio` cae en `default → ninguna`. O sea: si el usuario
  escribe "medialunas" cuando se le pregunta qué vendió, o "60" cuando se le
  pregunta el precio, el server no hace nada con eso. **El camino que sí anda es
  el normal**: el agente manda `items: [{ concepto: "medialunas", precio: 60 }]`
  explícito, que es su trabajo y lo hace bien.
  Se intentó al revés en agosto de 2026 —dos ramas nuevas acá— y se revirtió: que
  el server parsee castellano libre duplica un trabajo que ya hace el modelo, y
  cada filtro que hay que agregarle es un modo de falla FISCAL nuevo. Lo que rompió,
  y que es la especificación de lo que tiene que aguantar el día que se haga bien:
  · "no sé", "ni idea", "no me acuerdo", "nada" → quedaban impresos como la
    descripción de una línea de un CFE real.
  · "bolsas 25kg", "leche 1L", "harina 000" → el filtro de dígitos (puesto para
    frenar "eran 3 no 2") los rechazaba, y la conversación se trancaba en
    silencio en la pregunta más común del flujo.
  · un mensaje de más de 80 caracteres (el largo de `items.concepto` en Biller)
    → rechazado sin decir por qué.
  Además hay que resolver, sin enumerar frases a mano, la colisión con lo que el
  flujo ya usa para otra cosa: "listo" cierra los ítems, "a crédito" es la forma
  de pago, "en dólares" la moneda, "no" contesta el IVA.

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
