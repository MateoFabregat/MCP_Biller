# Decisiones de arquitectura

> Una decisión por sección, con lo que se descartó y qué costó elegir. No es
> documentación de lo que hay —para eso está [`ARQUITECTURA.md`](ARQUITECTURA.md)—
> sino de **por qué está así**, para que la próxima persona no rehaga el
> razonamiento ni deshaga la decisión sin saber qué compraba.

---

## ADR-001 — La lógica fiscal vive acá porque Biller no tiene dónde preguntarla

**Estado:** aceptada (04/09/2026), con una acción pendiente que la revertiría en
parte.

### El contexto

`src/services/` son 11.136 líneas, y la mitad es aritmética fiscal: totales,
desagregado de IVA por tasa, el umbral de las 5.000 UI, la derivación del tipo
de CFE, el cuerpo de una nota de crédito. Nada de eso es información nueva: el
backend de Biller **sabe todo eso**, porque es el que emite.

La pregunta razonable es entonces: ¿por qué lo calculamos de nuevo?

### La decisión

Se calcula acá **solo lo que hace falta ANTES de emitir**, y por una razón
concreta y medible: **la API de Biller no tiene un endpoint de validación ni de
dry-run.** Los quince endpoints que conocemos son de lectura, de emisión o de
alta; `POST /v3/comprobantes/emitir` **emite**. No hay forma de preguntar "¿esto
está bien y cuánto da?" sin que salga un documento fiscal real ante DGI.

El preview con los tres botones —✅ Emitir · ➕ Otro ítem · ✖️ Cancelar— es la
pieza central del producto: es donde una persona ve un total antes de que exista
el comprobante. Sin cálculo local, ese preview no existe, y sin preview lo único
que queda es emitir y después anular con una nota de crédito.

### Lo que se descartó

- **Pedírselo a Biller.** Es lo correcto y es lo que habría que hacer. No se
  puede hoy: no hay endpoint. Queda como el pedido de producto más valioso que
  este proyecto le puede hacer al backend (ticket 01).
- **Emitir y mostrar después.** Convierte cada duda en un CFE emitido más una
  nota de crédito. En un mostrador eso es inaceptable.
- **No mostrar total antes de emitir.** Es lo que hacen los formularios: el
  usuario confirma un payload que no entiende. Contradice la tesis del proyecto.

### Las consecuencias

- **A favor:** el preview existe; el error se ve antes del documento; el modelo
  nunca calcula un número.
- **En contra:** hay dos implementaciones de la misma regla fiscal —la nuestra y
  la de Biller— y pueden divergir. La divergencia es silenciosa: nosotros
  mostramos un total y Biller emite otro.
- **La mitigación que ya existe:** `npm run contrato` compara nuestro cálculo
  contra lo que Biller devuelve al emitir en TEST. Es la única red, y hoy corre
  a mano.

### El límite de la decisión

**Esto NO aplica a la analítica.** "¿Quién me debe?", los rankings, la
comparación de períodos y las cohortes no son un cálculo duplicado: la API no
ofrece agregados de ningún tipo, así que o se calculan acá o no existen.

---

## ADR-002 — El catálogo de clientes y productos es el historial, no un maestro

**Estado:** aceptada (04/09/2026).

### El contexto

Para ofrecer "elegí tu cliente" o "elegí el producto" hace falta una lista. La
API **no tiene GET de clientes ni de productos**: los dos se pueden crear
(`POST /v2/clientes/crear`, `POST /v2/productos/cargar`) y ninguno se puede
listar.

### La decisión

Los frecuentes se derivan del **historial de comprobantes emitidos**, que sí se
puede leer. Se implementó para clientes (`buscarClientesFrecuentes`).

### Lo que se descartó

- **Un maestro propio.** Habría que mantenerlo sincronizado con una fuente que
  no se puede leer: se desincroniza el primer día.
- **Productos con la misma técnica.** Se descartó por costo medido: el listado
  de comprobantes **no trae los ítems**. El detalle sale consultando comprobante
  por comprobante, así que un catálogo de productos es un **N+1 por diseño de la
  API** — decenas de requests por conversación. En su lugar se hizo
  `repetir_ultima_de: "mostrador"`, que resuelve el mismo caso con una consulta.

### Las consecuencias

- **A favor:** no hay nada que mantener, ordena por lo que de verdad se vende, y
  un cliente nuevo aparece solo en cuanto se le factura una vez.
- **En contra:** un cliente al que nunca se le facturó no está en la lista. Se
  entra por "➕ Otro cliente", que es el camino de siempre.
- **Costo real, medido:** ~15 requests la primera vez por conversación (la
  ventana de 90 días se pide en tramos de 7 días), cacheado en el borrador.

---

## ADR-003 — Una sola instancia, hasta que haya store compartido

**Estado:** aceptada con fecha de vencimiento.

### El contexto

Tres protecciones dependen de estado: la idempotencia fiscal, la idempotencia de
salidas a WhatsApp y el replay de webhooks entrantes. Las tres están
implementadas como journals append-only en disco, con locks `O_EXCL`.

### La decisión

El canal de WhatsApp se atiende con **una sola instancia** (o con varias
apuntando al mismo directorio en un filesystem compartido, que coordina por los
locks).

### Lo que se descartó, por ahora

- **Redis o Postgres para el estado compartido.** Es la solución correcta para
  más de una réplica, y la interfaz ya está lista para recibirla
  (`WebhookReplayStore`, `IdempotencyStore`). Se descarta hoy porque agrega una
  dependencia operativa —otro servicio que monitorear, respaldar y del que
  depende emitir— para un volumen que todavía no existe.

### Las consecuencias

- **En contra:** dos réplicas detrás de un balanceador deduplican por separado,
  así que el mismo reenvío de Meta puede ejecutarse dos veces.
- **Cuándo vence:** el día que haga falta más de una instancia. El cambio es la
  implementación del store, no el resto del sistema.
