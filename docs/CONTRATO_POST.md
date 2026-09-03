# Probe contractual de POST e idempotencia

Este probe es destructivo únicamente en el ambiente de prueba: crea un CFE de
test mediante `POST /v3/comprobantes/emitir` dos veces con el mismo
`numero_interno` y la misma clave de idempotencia, y
después verifica por GET que exista una sola coincidencia. Antes de escribir,
otro GET exige que el identificador todavía no exista. Los redirects se
rechazan en vez de seguirse. En la API real, esa inexistencia se expresa como
el 422 conocido que menciona `numero_interno`; cualquier otro 422 falla cerrado.
El segundo POST tiene dos resultados aceptables, pero no equivalentes: un 2xx
confirma que el proveedor reconoció el reintento; el 422 exacto
`Comprobantes[numero_interno]` / `Número interno no puede estar repetido`
demuestra que no se duplicó el efecto, pero **no** confirma soporte server-side
de `Idempotency-Key`. Cualquier otro error falla cerrado.
El contrato habitual
`npm run contrato` permanece exclusivamente de lectura.

Usar una cuenta dedicada de `https://test.biller.uy`. Guardar un payload válido
en un archivo fuera del repositorio y aplicarle permisos `0600`. Su campo
`numero_interno` debe ser único y coincidir con el execution id elegido.

Variables requeridas:

- `BILLER_API_BASE_URL=https://test.biller.uy`
- `BILLER_API_TOKEN` de la cuenta de prueba dedicada
- `BILLER_CONTRATO_POST_ENABLED=SI`
- `BILLER_CONTRATO_POST_CONFIRM=ENTIENDO_QUE_CREA_UN_CFE_DE_PRUEBA`
- `BILLER_CONTRATO_POST_PAYLOAD_PATH` apuntando al archivo privado
- `BILLER_CONTRATO_POST_EXECUTION_ID` igual al `numero_interno` del payload
- `BILLER_CONTRATO_POST_IDEMPOTENCY_KEY` única, de al menos 16 caracteres

Ejecutar `node --env-file=.env scripts/contrato-post.mjs`. La salida solo muestra los tres estados
necesarios: HTTP del primer intento, HTTP del segundo, cantidad de coincidencias
y si el header quedó realmente confirmado. No muestra tokens, payloads ni
respuestas fiscales.
