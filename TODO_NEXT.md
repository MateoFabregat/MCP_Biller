# TODO_NEXT

Cosas pendientes para la siguiente iteración, ordenadas por prioridad.

Lo que ya está hecho queda marcado `[x]` con el archivo donde vive, en vez de
borrarse: saber qué se resolvió y dónde vale más que una lista corta.

## Analítica de serie temporal (agosto 2026)

### Hecho

- [x] **`scripts/exportar-analitica.mjs`** — extracción de N meses a un JSON, y
  con `--html` un tablero autocontenido (mes a mes, mismo mes del año anterior,
  zafralidad, clientes). GET-only por estructura, igual que `contrato.mjs`.
  **No calcula plata**: importa `resumirFacturacion` y `filterEmitidos` de
  `dist/`, o sea las mismas funciones que contestan por MCP, justamente para que
  no exista un segundo criterio de qué es una venta. Verifica antes de escribir
  que el total del período **sea** la suma de los meses, y si no lo es escribe el
  aviso arriba de todo en vez de publicar un archivo que se contradice. El
  archivo sale 0600 y está en `.gitignore`: es la contabilidad de la empresa en
  claro.
- [x] **El contrato ahora cubre los dos campos de los que depende todo total.**
  `estado` (comparación exacta contra `"Aceptado DGI"`: un cambio de texto en la
  API vaciaría todos los totales **en silencio**) y `tasa_cambio` (que siga
  viniendo, y como número: una coma decimal se llevaría puesta la conversión de
  todas las facturas en dólares). La suite usa fixtures y por
  construcción no pueden ver esto.
- [x] **El contrato mide "Envío no corresponde"** (cuántos y cuánto suman) para
  que la decisión del ticket T05 se tome con un número y no de memoria.

### OJO: la serie mensual NO necesita una tool nueva

`biller_resumen_facturacion_periodo` con `agrupar_por: ["mes"]` y `desde`/`hasta`
explícitos **ya** devuelve la serie: la dimensión `"mes"` existe en
`DIMENSIONES` y `valorDimension` la resuelve por `fecha_emision.slice(0,7)`. Se
estuvo a punto de escribir una `biller_serie_mensual` que habría sido una segunda
implementación del mismo corte. Lo único que el grupo NO trae es el equivalente
en pesos y los excluidos por estado; por eso el script corre un
`resumirFacturacion` **por mes** en vez de un `agrupar_por` de una pasada.

### Lo que dejaron las dos revisiones del propio arreglo (ago-2026)

El fix de la tasa de la nota de crédito **abrió seis puertas nuevas** para
acreditar mal, y las encontró la revisión, no la suite. Todas cerradas y con
test; se listan porque son el mapa de por dónde se rompe este módulo:

- [x] un ítem con `indicador_facturacion: null` contaba como unanimidad y
  acreditaba el total entero a la tasa del resto (610 exentos al 22%);
- [x] el camino por ítems iba **antes** que las guardas de "otra tasa" y "el
  desglose no cierra", así que las hacía inalcanzables;
- [x] `total` null o 0 emitía una nota de crédito por **$0**: un CFE real que
  consume numeración y no anula nada;
- [x] el epsilon de 0,02 no contemplaba que dividir por 0,22 **amplifica el
  redondeo 4,55 veces**: dejaba la nota un centavo corta, o reportaba "no cierra"
  sobre facturas sanas de diez líneas. Ahora el residuo se absorbe en la línea
  gravada más grande y solo se rechaza lo que el redondeo no explica;
- [x] faltaba `tasa_cambio` en el cuerpo: sin él Biller usa la cotización de
  HOY, no la del original (~1.600 pesos de IVA de más en una factura de U$S 10.000);
- [x] una exportación se acreditaba con indicador 1 (exento) en vez de 10.

Y de la revisión de seguridad:

- [x] `claveRecordatorio` escribía **RUT y teléfono en claro** al registro
  persistente de idempotencia, una línea por recordatorio. Ahora va hasheado; el
  día queda en claro (no identifica y hace legible el archivo).
- [x] `--out` de `exportar-analitica.mjs` era libre y `.gitignore` protege por
  patrón: `--out=./resumen.json` dejaba la contabilidad sin ignorar dentro del
  repo. Ahora exige `analitica-*.json`, y valida **antes** de pedir nada.

### Falta, de esas mismas revisiones

- [x] **El ciclo de `confirmation_token` volvió a ser una costura central.**
  `ApprovalCycle`, provisto por `ToolContext`, emite y verifica los approvals de
  las siete tools de escritura, `biller_recordatorio_cobro` y la revisión de
  anulaciones. El token v2 usa HMAC-SHA-256 con una clave server-side exclusiva
  del tenant y autentica payload, endpoint, ambiente, tenant, empresa,
  conversación, timestamp y versión de política. El formato SHA-256 anterior se
  rechaza y obliga a repetir el dry-run.
- [x] **`cuerpo_sugerido` sale con las marcas `⟦dato-no-confiable⟧` adentro.**
  RESUELTO (sep-2026). La clave está en `SUBARBOLES_PROPIOS`, así que el cuerpo
  sale limpio y no depende de que `limpiarMarcasProfundo` lo rescate. Esa
  exención tenía una contracara que sí seguía abierta y se cerró en el mismo
  paso: el `concepto` de la nota se armaba con la `serie` del original, que es
  texto libre de la API, o sea texto de tercero saliendo SIN marcar por el único
  campo pensado para volver a entrar a un CFE. `identificacionOriginal`
  (`src/services/anulacion.ts`) la restringe a lo que una serie de DGI puede
  ser; lo fija `tests/anulacion.test.ts` ("lo que Biller escribe no entra libre
  al concepto de la nota").
- [ ] **La identidad del token vale lo que valga el cliente.** Un modelo (o una
  inyección) puede afirmar ser **otro número ya autorizado** y `verificarRemitente`
  lo acepta. El binding separa a dos humanos autorizados bajo un cliente honesto;
  no protege contra el reenvío deliberado. Vale para las ocho tools, no es nuevo,
  pero el comentario de `recordatorioCobro.ts` promete un poco más de lo que da.
- [x] **Las retenciones/percepciones del original no se revierten** en la nota
  sugerida: cerrado de forma segura (sep-2026). Si existen, ya no se entrega un
  cuerpo parcial que parezca ejecutable; el plan queda sin cuerpo y exige
  reconstrucción/revisión explícita con el detalle original.

### Falta — y necesita una decisión, no código

- [ ] **Productos y descuento por cliente siguen bloqueados.** Es el N+1 de
  `items`, y lo desbloquea el store de `docs/STORE.md` (Fase 1 de
  `docs/PLAN_V2.md`, cero líneas escritas). El brainstorm lo bajó a Ola 4 con el
  argumento de que era "infraestructura especulativa para un solo caso de uso" —
  **ese argumento ya no aplica**: con la analítica de serie encima, los casos son
  productos, descuento real por cliente, rubro y cobertura completa del período.
  Lo que sigue abierto es lo que el propio doc marca en su §6: el store deja la
  contabilidad completa **en un archivo sin cifrar**, y hay que decidir permisos,
  cifrado en reposo y qué pasa con ese archivo cuando la empresa se va. Es
  decisión del dueño del producto, no del que teclea.
- [ ] **Rubro del cliente.** Derivable hoy: `GET /v2/dgi/empresas/actividad-empresarial`
  por RUT. **Rate limit de 1 req/s** (las consultas a DGI van por el límite
  estricto, no por el de 30), así que se cachea por cliente o no se hace.

## Auditoría integral (agosto 2026) — cuatro revisiones en paralelo

Seguridad, fiscal, arquitectura (CTO) y capa conversacional revisaron todo el
repo, cada hallazgo verificado ejecutando código. Lo que se arregló en esta
tanda está marcado; lo que queda tiene repro y prioridad. El resto de este
archivo son los backlogs previos, todavía válidos.

### Ya arreglado en esta tanda

- [x] **Los fixtures de fecha se anclaban a UTC → la suite fallaba todas las
  noches (21:00–00:00 UY).** Anclados a `hoyComoDateUy()` en
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

- [x] **El canal de ERROR saltea la envoltura de datos no confiables.** Hecho
  (sep-2026): los textos de validación 422 y `details` del upstream se envuelven
  como no confiables, sin doble envoltura y con redacción de secretos.
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

- [x] **`biller_recordatorio_cobro` no ata el `confirmation_token` a la
  identidad**: hecho (ago-2026). Se exportó `identidadDeEscritura` de
  `tools/write/shared.ts` y se pasa como 5º argumento en las dos fases.
  Además hubo que **declarar `remitente` en el inputShape**: `z.object`
  descartaba el campo que agrega la barrera, así que la identidad habría sido
  `null` siempre y el arreglo no habría atado nada. Fijado en
  `tests/recordatorioCobro.test.ts` ("el token de un remitente NO lo puede
  confirmar otro").
- [x] **NC recibida suma IVA compras en vez de restarlo:** corregido (sep-2026).
  `posicionIva.ts` y `proveedores.ts` aplican el signo fiscal del tipo de CFE a
  neto, IVA, total y retenciones. Para una NC usan `-abs`, por lo que funciona
  tanto si la API entrega magnitudes positivas como si ya vienen negativas;
  hay regresiones para ambas formas.
- [x] **La NC que sugiere `biller_plan_anulacion` va siempre a 22%**: hecho
  (ago-2026). `lineasNota` (`src/services/anulacion.ts`) deriva la tasa en tres
  escalones: (1) `items[].indicador_facturacion` del original cuando todas las
  líneas comparten indicador —el dato, no una reconstrucción—; (2) si no hay
  ítems, reconstruye el bruto de cada porción desde `tot_iva_tasa_min/bas/otra`
  con `bruto = iva + iva/tasa`, válido porque el cuerpo va con
  `montos_brutos: true`, y abre una línea por tasa más una exenta con el resto;
  (3) si no puede saberlo —sin ítems y sin desglose, IVA a "otra tasa", o un
  desglose que no cierra contra el total— devuelve `cuerpo_sugerido: null` con
  el motivo, en vez de adivinar. `planAnulacion.ts` ahora pasa `iva` e `items`.
  Hay regresiones en `tests/anulacion.test.ts`.
- [x] **El aviso "receptor obligatorio" no llega al resumen que aprueba el
  humano.** Hecho (sep-2026): las advertencias críticas de receptor se muestran
  arriba de los importes del preview y viajan al cuerpo real de WhatsApp.

### P0/P1 conversacional — falta (repro confirmado; fixes con archivo:línea)

- [x] **Línea a $0/negativa al final deja el flujo mudo.** Hecho (sep-2026): la
  rama ofrece botones vinculados a posición+monto para conservarla o quitarla;
  un botón viejo no puede modificar otra línea.

### P0 de emisión endurecida — hecho en sep-2026

- [x] **Dos confirmaciones simultáneas podían atravesar juntas la idempotencia.**
  La key se reserva como `in_flight` antes del POST; el segundo claim se bloquea.
- [x] **Un POST aceptado cuya respuesta se pierde quedaba ambiguo.** La key pasa
  a `ambiguous` y no se reintenta; el mensaje exige verificar primero en Biller.
- [x] **`crear_recibo` no inspeccionaba `pago.monto`.** Ahora aplica el tope al
  monto autoritativo, rechaza malformados/no finitos/negativos y cubre el borde.
- [x] **Fechas ISO imposibles podían pasar.** Los schemas y períodos validan el
  día real del calendario, incluidos febrero y meses de 30 días.
- [x] **La consulta previa por `numero_interno` fallaba abierta.** Si el GET no
  puede probar que el identificador está libre, no se ejecuta el POST.
- [x] **`precio_copiado` sobrevive a `items` explícitos**: hecho (ago-2026).
  `fusionarItems` borra la marca con **dos** disparadores, no uno: precio
  explícito (el prescripto) y **concepto distinto al previo**. El segundo es el
  que cierra el agujero real: la fusión es posicional, así que la marca de la
  línea 1 de la venta copiada le quedaba puesta a otro producto en esa posición,
  y su 0 heredado pasaba por bonificación. Hay regresiones en
  `tests/borradorStore.test.ts`.
- [x] **Un producto queda como razón social en el paso `cliente`.** Resuelto
  (ago-2026): `borradorEmision.ts` conserva la clasificación producto/cliente
  para consumidor final y las regresiones de emisión guiada lo verifican.
- [x] **`calidad()` del enrutador empata exacto con inclusión**: hecho
  (ago-2026). `Busqueda` lleva ahora `precision: "exacto" | "inclusion"` —
  `confianza` valía 1 para las dos y eran indistinguibles— y `calidad()` puntúa
  exacto=3, inclusión=2, empate=1.5, aproximado=1. Verificado antes/después:
  "me equivoqué con el recibo" en `read_only` pasó de `menu:anular` (una NOTA DE
  CRÉDITO por un recibo) a `menu:cancelar_recibo`. El sinónimo exacto ya existía
  en el catálogo; lo que fallaba era el desempate. Regresiones + caso de
  eval (44/44).
- [ ] **Ecos crudos**: `$-200` en pregunta/botón (`emision.ts:1577`), precios
  huérfanos sin formatear (`borradorEmision.ts:423`). Usar el helper `importe()`.
- [x] **`SKILL.md` §fechas**: resuelto (sep-2026); exige usar alias simbólicos
  (`hoy`, `mes_actual`…) y deja la resolución al servidor en hora UY.
- [x] **`SKILL.md` actualizado.** Resuelto (sep-2026): cubre las capacidades
  vigentes, modos operativos, períodos simbólicos en hora UY, plan de anulación
  y la separación estricta de monedas.
- [ ] **Corpus de evals**: 29 casos nuevos propuestos (jerga de mostrador,
  "ayer", singulares, vencimientos). Meterlos JUNTO con los fixes de sinónimos o
  el gate `--min 95` frena el commit. Archivo en el scratchpad de la sesión.
- [ ] **Texto**: el encabezado del menú muestra el RUT donde va el nombre
  (`render.ts:37` recibe `defaultEmpresaRut`); "CFE"/"ambiente"/"servidor" son
  jerga; "una de estas dos cosas" con 3 candidatas (`render.ts:66`).

### Arquitectura / deuda (CTO) — falta

- [x] **`CacheDetalles`: ownership, habilitación y LRU por tenant.** Resuelto
  (sep-2026): cada `ToolContext` construye su propia instancia con la config
  efectiva; conserva TTL y copias defensivas, y toca en hit para desalojar LRU.
- [ ] **Zod v4 NO borra `transport/dialecto.ts`** (verificado contra el SDK
  1.29.0: llama a `toJsonSchemaCompat` sin `target`), y `inlinearRefs` no depende
  del dialecto. Corregir `README.md:677`, `docs/EQUIPO.md:100,254` que prometen
  lo contrario. El canario de `tests/dialecto.test.ts` es la única condición de
  retiro.
- [x] **Publicar en npm**: hecho. `biller-mcp-server@0.1.1` está publicado y
  se instala con `npx biller-mcp-server`; el 404 de esta nota ya no aplica.
  Se agregó el `LICENSE` (MIT) que faltaba en el repo (`package.json` ya
  declaraba la licencia, pero no había archivo).
- [x] **Contratos numéricos de documentación.** Resuelto (sep-2026): los conteos
  de tools salen de las listas canónicas, `.env.example` está bajo el guard y la
  documentación no mantiene una cifra manual de tests.
- [x] **Alta plug-and-play y recarga, fases 1–2**: `onboard --crear` deriva RUT/sucursal de
  la API, genera la credencial, valida el registro entero antes de escribir
  (0600) y verifica contra la API real. `SIGHUP` publica snapshots atómicos e
  invalida únicamente tenants afectados; Fase 3 (OAuth/remoto) sigue diseñada
  en detalle en `docs/PLAN_PLUG_AND_PLAY.md`.
- [ ] **Pista 2 (remoto + OAuth)**: Resource Server contra un IdP de tercero con
  DCR (no construir Authorization Server propio). Reusa `autenticarConTenants`
  como segunda rama. Escritura remota queda para el final (no hay `remitente`
  verificado: falta un equivalente al ancla de `identidadDeConversacion`).
- [x] **Extender el guard `fechaUyGuard` a `tests/`**: resuelto (sep-2026) para
  defaults civiles observados, con allowlist razonada para instantes técnicos.
- [x] **Partir `handleEmisionGuiada` y sacar los `construirSubmenu*` a
  `render.ts`.** HECHO (sep-2026), por diferencial contra el corpus (44/44) más
  la suite completa y `check:readonly`. Los 13 constructores de mensajes viven
  en `render.ts`; el movimiento exigió mudar `PREFIJO_PASO` a `protocolo.ts`
  —tenerlo en `emision.ts` cerraba un ciclo entre los dos módulos— y
  `simboloMoneda`/`montoConSigno` a `services/importe.ts`. `emision.ts` bajó de
  1758 a 1424 líneas. `handleEmisionGuiada` pasó de 555 a 309 con dos funciones
  con nombre: `estadoDesdeArgumentos` (los argumentos convertidos en tipos) y
  `aplicarRespuestaDelUsuario` (lo único que muta el estado con texto libre).

## Ola D — de la demo a producción (04/09/2026)

Los tickets están en `.scratch/ola-d-produccion/issues/`, en formato
agente-listo, y las decisiones que los ordenan en
[`docs/DECISIONES.md`](docs/DECISIONES.md) (ADR-001 a 003).

| # | Ticket | Bloquea producción | Estado |
|---|---|---|---|
| 01 | Pedirle a Biller un endpoint de validación (dry-run) | no | pedido de producto |
| 02 | Verificar cómo llega un audio transcripto | sí | necesita un teléfono |
| 03 | Exportación: qué `indicador_facturacion` lleva | sí (ese caso) | **decisión del dueño** |
| 04 | Cuenta corriente con fecha de corte | no | abierto |
| 05 | Reintentar el 429 de Biller | sí | ✅ hecho (04/09/2026) |
| 06 | Todo submenú con salida de un toque | sí | abierto |
| 07 | Catálogo único de tipos de CFE | no | abierto |
| 08 | El cobro también con botones | no | abierto |
| 09 | Infraestructura: dominio, secretos, backup, monitoreo | sí | abierto |
| 10 | Los seis POST que faltan validar en TEST | sí | abierto |

## P0 — Antes de poner en producción

- [ ] **Validar endpoints de escritura contra la API real de test.**
  Los schemas de los POST en el OpenAPI solo traen ejemplos, no schemas estrictos.
  Hacer una emisión real en `test.biller.uy` con `biller_emitir_comprobante`
  (dry-run → confirm) y confirmar que Biller acepta el payload.
  Idem para `biller_crear_cliente`, `biller_crear_recibo`, etc.
  Parcial: la emisión mínima real por `POST /v3/comprobantes/emitir` fue aceptada
  en TEST el 03/09/2026. Los preview también salieron contra el server real
  (dry-run, 28/07) y de ahí
  salieron hallazgos que contradicen al OpenAPI —`direccion`/`ciudad`
  obligatorias, 422 por `numero_interno` inexistente— anotados en
  [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) §7. Faltan validar los demás
  endpoints de escritura (cliente, producto, recibo, pago y anulación).

- [x] **Confirmar soporte server-side del header `Idempotency-Key`.**
  Validado en TEST el 03/09/2026 contra `/v3/comprobantes/emitir`: el primer POST
  devolvió 201 y el reintento con el mismo body, `numero_interno` y header devolvió
  422 por número interno repetido. El header no quedó confirmado. La defensa real
  es el `numero_interno` único más el journal persistente del MCP.

- [x] **Publicar como npm package o binario.** Hecho: `biller-mcp-server@0.1.1`
  publicado (`package.json` sin `private: true`), instalable con
  `npx biller-mcp-server`. El README ya documenta el flujo de instalación.

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
- [x] **"Envío no corresponde" no cuenta en ningún total:** corregido
  (sep-2026). `esVentaValida` (`src/services/estadoDgi.ts`) sostiene que es una
  venta real y facturada, y que excluirla porque no viajó individualmente a DGI
  es confundir el canal de reporte con la validez del documento. Todos los
  totales comparten ahora `estaAceptado`, que reconoce la aceptación individual y
  el reporte diario válido, mientras sigue excluyendo pendientes, rechazados y
  estados desconocidos. El diferencial está cubierto transversalmente en
  `tests/estadoDgi.test.ts`: en un comercio de tickets chicos puede mover el
  total de casi toda la facturación.

  **DECIDIDO POR EL DUEÑO (03/09/2026)**, con el cambio ya en la rama y el
  impacto sobre la mesa: "Envío no corresponde" CUENTA. Reemplaza al criterio
  anterior ("solo Aceptado DGI, para coincidir con lo que muestra Biller"). Si
  alguna vez el panel de Biller muestra un total distinto al del asistente, esta
  es la primera diferencia que hay que mirar — y es una diferencia esperada, no
  un bug.

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

- [x] **Una línea a $0 o negativa AL FINAL, mandada por el agente, tranca el
  flujo.** Resuelto (sep-2026): `emisionGuiada` ofrece conservarla o quitarla
  con acciones ligadas a posición e importe, y `tests/emisionGuiada.test.ts`
  cubre ambos caminos.

- [x] **`precio_copiado` no se pierde con `items` explícitos.** Resuelto
  (ago-2026): `fusionarItems` invalida la marca cuando cambia el precio explícito
  o el concepto, con regresiones en `tests/borradorStore.test.ts`.

- [x] **En el paso `cliente`, un producto queda como razón social.** Resuelto
  (ago-2026): `borradorEmision.ts` conserva la clasificación producto/cliente
  para consumidor final y la cubren las regresiones de emisión guiada.

- [x] **`$-200` en la pregunta y en el botón de descarte.** RESUELTO (sep-2026):
  `montoConSigno` (`src/kapso/emision.ts`) es el único lugar donde se decide que
  el signo va antes del símbolo, y lo usan los cinco ecos de importe del flujo
  más el aviso de precios sin ubicar. Lo fijan `tests/emisionGuiada.test.ts`
  ("una línea de precio negativo se nombra con la convención uruguaya") y el
  test de `formatearPrecioAviso` en `tests/borradorEmision.test.ts`.

- [x] **Los precios huérfanos se ecoan crudos.** Ya estaba resuelto y la entrada
  quedó sin marcar: el aviso usa `formatearPrecioAviso` con la moneda efectiva
  (`src/kapso/borradorEmision.ts:439`), cubierto en `tests/emisionGuiada.test.ts`
  ("$6.500" en los warnings) y en `tests/borradorEmision.test.ts`. Verificado en
  sep-2026 al retomar el backlog.

- [x] **Sobreconteo cosmético en los avisos de estado.** Ya estaba resuelto y la
  entrada quedó sin marcar: en `cohortes.ts` y `comparacion.ts` el `sinEstado`
  se incrementa DESPUÉS del filtro de `total`/`moneda` nulos, con el porqué
  escrito al lado. Verificado en sep-2026 al retomar el backlog.

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

- [x] **Webhook de Kapso multi-empresa**: YA ESTABA HECHO — esta nota estaba
  desactualizada y se verificó en ago-2026. `normalizarEvento`
  (`src/kapso/webhook.ts`) **sí** lee el `phone_number_id` antes de cualquier
  salida temprana, `registry.ts` mantiene el índice `porPhoneNumberId`, y
  `http.ts` atiende con el contexto de esa empresa (ruta
  `/kapso/webhook/<tenant-id>`, y 404 en la ruta vieja con multi-empresa).
  Cubierto por `tests/webhookMultiEmpresa.test.ts`.

- [ ] **Filtros nativos de moneda/cliente en emitidos.**
  Confirmar si la API acepta `moneda` o `rut_receptor` como query params;
  si es así, el filtro local pasa a ser secundario (post-filter para compatibilidad).

## P2 — Robustez y observabilidad

- [x] **Audit log persistente entre sesiones.** Hecho: `FileIdempotencyStore`
  (append-only en disco, `BILLER_IDEMPOTENCY_LOG_PATH`) en
  `src/write/idempotency.ts`, y el audit log en `src/write/audit.ts`
  (`BILLER_AUDIT_LOG_PATH`). El archivo guarda key + timestamp, nunca el payload.
  Ojo: en serverless el disco no sobrevive — ver `src/transport/serverless.ts`.

- [x] **Rate-limit configurable por env.** Ya estaba resuelto y la entrada quedó
  sin marcar (ola A): `BILLER_RATE_LIMIT_DEFAULT_RPS` y `BILLER_RATE_LIMIT_DGI_RPS`
  se validan en `config.ts` y `createToolContext` los inyecta en los limiters de
  los tres clientes —lectura, escritura y detalles—, uno por empresa. Los valores
  de `rateLimit.ts` quedaron como default, no como techo. Verificado en sep-2026.

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

- [x] **Llevar a `config.ts` lo que hoy se lee suelto del entorno.** Resuelto
  (sep-2026): `BILLER_HTTP_SESSION_TTL_MS` y `BILLER_HTTP_MAX_SESSIONS` salen de
  la configuración validada y `src/transport/http.ts` consume esos valores;
  `tests/config.test.ts` cubre lectura y validación.

- [x] **Enchufar la habilitación de cache por empresa**: YA ESTABA HECHO para
  `CacheVentanas` — nota desactualizada, verificada en ago-2026.
  `ContextosPorTenant` la llama en su constructor (`src/tenants/contextos.ts`),
  cubierto por `tests/cachePorEmpresa.test.ts`. **Queda vivo el otro lado**, que
  se movió al ítem de `CacheDetalles` de la sección de arquitectura: ese cache
  lee `BILLER_CACHE_ENABLED` de `process.env` una sola vez al cargar el módulo,
  así que apagar el cache de una empresa no lo apaga ahí. Ojo también con el
  singleton de módulo: manda la ÚLTIMA instancia construida (hoy hay una sola).

- [x] **Derivar las rutas de persistencia de un `BILLER_DATA_DIR` + `tenant.id`.**
  Resuelto (ago-2026): `config.ts` deriva audit, idempotencia y borradores por
  empresa; `tests/config.test.ts` y `tests/tenants.test.ts` verifican aislamiento,
  validación y el comportamiento sin directorio base.

- [x] **Resource MCP con catálogo de tipos de CFE.** Resuelto (sep-2026):
  `registerAllResources` publica `biller://catalogos/cfe` en ambos modos. Es
  local, determinístico y read-only; comparte las tablas y requisitos canónicos
  con las tools, sin red ni datos de tenant.

- [ ] **Tests de integración contra `test.biller.uy`** (ci opcional).
  Un suite separado con token real y `process.env.CI_INTEGRATION=true` que
  verifique los endpoints reales. No correr en cada PR, solo manualmente.

## P3 — Deuda técnica conocida

- [x] **Campo `estado` en emitidos** — sí viene en el GET y ya se usa:
  `src/biller/normalize.ts` lo mapea y `solo_aceptados` (default `true`) cuenta
  CFE válidos: "Aceptado DGI" y "Envío no corresponde" (reporte diario).
  Queda abierto lo otro: no hay un campo de **anulación**, así que una venta
  anulada por NC se descuenta por el signo negativo de la nota, no por estado.

- [x] **Estructura de `cliente` en emitidos** — normalizado: `extractFromCliente`
  en `src/biller/normalize.ts` tolera las dos formas (`[]` y objeto), así que el
  filtro `cliente_rut` ya no depende de cuál mande la API.

- [x] **`defaultSucursalId` en tools de escritura** — cerrado (verificado sep-2026):
  `aplicarSucursalPorDefecto` está en `emitirComprobante` Y en `crearRecibo`, que
  son las dos únicas escrituras cuyo cuerpo lleva `sucursal`. Pago, cliente y
  producto no tienen el campo en su schema, así que ahí no hay nada que aplicar.
