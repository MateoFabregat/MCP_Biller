# Plan plug-and-play: de "un comando por empresa" a "cada empresa desde su propio Claude/ChatGPT"

Estado al 03/09/2026. Las Fases 1 y 2 están **implementadas**; la 2.5 (el alta
del WhatsApp por empresa) está planificada y su precondición técnica ya está
resuelta; este documento
es el handoff de la Fase 3 para quien la ejecute. Antes de
tocar nada: leé `docs/HANDBOOK.md` (las barreras), `docs/ARQUITECTURA.md` (el
mapa) y la sección "Auditoría integral" de `TODO_NEXT.md`, que lista lo
que quedó abierto con repro.

## El principio que ordena todo el plan

> **Se automatiza lo que se puede DERIVAR de un hecho verificable. No se
> automatiza ninguna barrera.**

Las cuatro cosas que quedan manuales para siempre —capability mode,
`BILLER_WRITE_ENABLED`/`ALLOW_PRODUCTION`, los topes de monto y las dos
allowlists de teléfonos— no son fricción: son **la decisión**. Es el mismo
criterio de `VARIABLES_QUE_NO_SE_HEREDAN` (`src/tenants/registry.ts`), un nivel
más arriba. Y la regla del null honesto: si la derivación da más de un
candidato, se listan y se pregunta; ante la duda no se elige (misma doctrina
que `services/resolver.ts`).

## Fase 1 — `onboard --crear` ✅ HECHA

`node scripts/onboard.mjs --crear --nombre="Panadería Rivera"`:

- Pregunta token + ambiente (flags `--token= --ambiente=` para pipelines).
- Sonda la API (90 días, solo GET) y deriva `rut_emisor` → `BILLER_DEFAULT_EMPRESA_RUT`
  y las sucursales (una → default; varias → pregunta; cero → null honesto y lo dice).
- Si el proceso define `BILLER_MAX_MONTO_*`, los **pregunta** por empresa (no
  los autocompleta: el registro los exige explícitos, `--max-uyu=/--max-usd=`).
- Genera `id` (slug, charset del registro) y `auth_token` (32 bytes, se muestra
  UNA vez).
- Valida el registro ENTERO con `construirRegistro` **antes** de escribir, y
  escribe la entrada en `BILLER_TENANTS_PATH` con modo 0600. Después relee del
  disco y verifica el alta contra la API real con `entornoDe` (el overlay de
  verdad, no un merge parecido).
- Verificado: el guard de `BILLER_API_TOKEN` duplicado frena el alta con el
  disco intacto.

Lo que NO hace, a propósito: no toca Kapso, no habilita escritura, no inventa
allowlists. Todo eso queda impreso como "pendiente, a mano y a conciencia".

## Fase 2 — Recarga en caliente del registro ✅ HECHA

El alta pasa a ser `onboard --crear` + `kill -HUP <pid>`, sin reiniciar el
proceso. `HolderRegistroTenants` publica solo snapshots ya validados; el
transporte y el webhook leen el snapshot vigente por request.

**Comportamiento entregado:**

1. `SIGHUP` carga y valida el registro completo; ante error, conserva el
   snapshot, contextos y sesiones anteriores.
2. Ante una carga válida, se invalidan solo contextos y sesiones de tenants
   eliminados, con overlay distinto o con `auth_token` rotado. Los demás objetos
   se preservan por identidad.
3. El modo mono-tenant ignora `SIGHUP` sin ruido. No hay watcher ni endpoint
   HTTP de administración.

**Archivos:** `src/tenants/holder.ts`, `src/tenants/recarga.ts`,
`src/tenants/contextos.ts`, `src/index.ts`, `src/transport/http.ts` y sus tests.

**Qué NO hacer:** no recargar "por archivo watcheado" (fsevents + iCloud en
macOS = recargas fantasma; ya nos comimos los archivos " 2" — ver
`scripts/check-empaque.mjs`). No aceptar el registro nuevo si
`construirRegistro` lanza. No conservar contextos "por las dudas".

## Fase 2.5 — El alta del WhatsApp de la empresa (est. 2–3 días)

**El hueco que llena.** Las Fases 1 y 2 automatizan el lado de Biller: un token
verificable entra, y de ahí se DERIVAN el RUT emisor, las sucursales y la
entrada del registro. Del lado de WhatsApp no hay nada: `onboard --crear`
imprime "pendiente, a mano y a conciencia" y ahí termina. Hoy conectar el
WhatsApp de una empresa es entrar a un panel, crear un número, copiar tres
identificadores y pegarlos en un `.env`. Eso no escala a la empresa número diez
y —peor— es donde se cometen los errores que después son un chat mudo.

**Lo que lo hace posible.** Kapso tiene una API multi-empresa
(`https://api.kapso.ai/platform/v1`, ver [`KAPSO.md`](KAPSO.md) §7.3) donde cada
empresa es un `customer` con sus propios números, y un **setup link** que la
empresa abre para conectar su WhatsApp con su propia cuenta de Facebook. Nadie
del lado nuestro toca las credenciales de Meta de la empresa: esa propiedad es
la que hace que el alta escale sin volverse un riesgo.

**El plan, con el mismo principio de siempre** (se automatiza lo que se DERIVA
de un hecho verificable; no se automatiza ninguna barrera):

1. `onboard --whatsapp` sobre una empresa que YA existe en el registro:
   - `POST /platform/v1/customers` con el nombre de la empresa y
     `external_customer_id` = el `id` del registro. Guarda el `customer_id` como
     metadato del tenant. **Derivado de un hecho verificable**: la empresa ya
     está dada de alta y validada contra la API de Biller.
   - `POST /platform/v1/customers/{id}/setup_links` y **imprime la URL**. Acá el
     script se detiene: lo que sigue lo hace la empresa, con su Facebook. No hay
     forma —ni conviene que la haya— de que lo hagamos por ella.
2. `onboard --whatsapp --confirmar` cuando la empresa avisa que ya conectó:
   - lee el `phone_number_id` del customer y lo escribe como
     `KAPSO_PHONE_NUMBER_ID` de esa empresa,
   - **genera un secreto de webhook nuevo, de 32 bytes, propio de esa empresa**
     (nunca uno compartido: es lo único que separa el webhook de una empresa del
     de otra) y lo registra con
     `POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks` apuntando a
     `https://<host>/kapso/webhook/<id-de-empresa>`,
   - verifica el alta mandándose un evento de prueba firmado y comprobando que
     la ruta contesta 200. **Un alta que no se verifica contra el sistema real
     no es un alta**: es la misma regla que ya sigue la Fase 1 con `entornoDe`.
3. **Lo que NO hace, y no es fricción sino la decisión**: no habilita escritura,
   no arma las dos allowlists de teléfonos, no fija topes de monto y no activa
   el workflow con el Agent Node. Son las mismas cuatro barreras humanas de
   siempre, más una quinta que es específica de este canal: **quién puede
   escribirle al bot y a quién puede escribirle el bot**.

**Precondición técnica, ya resuelta:** un webhook registrado por la API de
plataforma se firma con `X-Webhook-Signature` (hex pelado), no con el
`x-hub-signature-256` de Meta. El server leía solo el segundo, así que este
camino de alta habría entregado un chat mudo con 401 en el log. Ahora acepta los
dos — ver [`KAPSO.md`](KAPSO.md) §7.4. **Sin ese arreglo, esta fase no funciona**,
y el modo de falla no se parece en nada a su causa.

**Criterios de aceptación:**
- Dar de alta una empresa de prueba de punta a punta sin editar un archivo a
  mano, salvo las cuatro barreras.
- Dos empresas dadas de alta por este camino tienen secretos de webhook
  DISTINTOS, y el evento de una firmado con el secreto de la otra da 401 contra
  las dos rutas.
- El script es idempotente: correrlo dos veces no crea dos customers ni dos
  webhooks.
- El `phone_number_id` que quedó en el registro coincide con el que llega en
  `value.metadata` del primer evento real.

**Costo que hay que mirar antes de escalar:** el plan de Kapso se elige por
**números conectados**, no por mensajes (KAPSO.md §7.1). Tres empresas entran en
Pro; a partir de ahí son US$ 10 por empresa por mes hasta que conviene Platform.

## El alta de una empresa, hoy: qué se pide, qué se deriva, qué no se automatiza nunca

> Levantado el 03/09/2026 contrastando el código, `.env.example` y el
> `HANDBOOK`. Es la lista real, no la ideal.

### Lo que hay que pedirle a una empresa nueva

Cinco cosas. Todo lo demás se genera o se sonda:

1. **El token de la API de Biller** y si es de test o de producción.
2. **Los teléfonos que pueden preguntar** y **los que pueden recibir**
   documentos. Normalmente el dueño y el contador. Son dos listas distintas y
   ninguna se hereda de nadie.
3. **Si va a emitir desde el chat**: sí o no, con qué tope por moneda, y si eso
   es en producción.
4. **Si usa WhatsApp**: el número y la clave de su cuenta de Kapso (o el
   `setup_link` de la Fase 2.5, que evita pedirle credenciales).
5. **Opcional**: cuál es su sucursal principal, si tiene más de una.

### Lo que el sistema deriva solo

| Dato | De dónde sale |
|---|---|
| RUT emisor | Se sonda la API con el token: 90 días de comprobantes |
| Sucursales | Ídem. Una sola → default; varias → pregunta; ninguna → lo dice y no inventa |
| Id de la empresa | Slug del nombre |
| Bearer del MCP | 32 bytes aleatorios, se muestran una vez |
| Las cinco rutas de persistencia | Derivadas del directorio de datos y del id |

### Lo que hoy se hace a mano y **no debería**

Son claves, no decisiones. Generarlas automáticamente no afloja ninguna barrera:

- **El secreto de aprobación** (`BILLER_APPROVAL_SECRET`): material de clave.
- **El secreto del webhook** (`KAPSO_WEBHOOK_SECRET`): ídem, y encima uno por
  empresa, que es lo único que separa el webhook de una del de otra.
- **La URL del webhook**: el server ya sabe construirla; hoy el operador la
  arma a mano y ahí se cometen los errores que después son un chat mudo.
- **El recordatorio del `SIGHUP`**: el alta no queda viva hasta que alguien se
  acuerda de recargar. Que lo haga el propio script.

### Lo que NO se automatiza nunca, y por qué no es fricción

Estas cinco **son la decisión**, no un trámite:

1. **Quién puede preguntarle al bot** y **a quién puede escribirle el bot**.
2. **El modo de capacidades**: consulta o escritura.
3. **Habilitar la escritura** y **habilitar producción**.
4. **Los topes de monto** por moneda.
5. **Activar el flujo del Agent Node.**

Autocompletar cualquiera de ellas es decidir por el dueño de una empresa sobre
su propia facturación.

### Lo que no se puede compartir entre empresas, jamás

El token de Biller, el bearer del MCP, el secreto de aprobación, la clave y el
número de Kapso, el secreto del webhook, las dos allowlists, los tres flags de
escritura, los topes, el RUT y las sucursales, y los cinco archivos de
persistencia —ni siquiera su directorio—.

El registro ya lo hace cumplir por construcción: hay una lista explícita de
variables que no se heredan, el token de Biller duplicado entre dos empresas es
fatal, y el número de WhatsApp duplicado también. **Con una excepción que se está
cerrando**: dos ids que difieren solo en mayúsculas comparten directorio en
macOS y en Windows, y con él comparten el audit fiscal y los borradores.

## Fase 3 — Remoto + OAuth: cada empresa desde su Claude/ChatGPT (est. 1–2 semanas)

**La meta:** un cliente de ChatGPT o Claude web/móvil se conecta a
`https://mcp.biller.uy` y el usuario entra con su cuenta — sin editar archivos,
sin tokens pegados a mano.

**La decisión de riesgo mínimo, ya tomada (no rediscutir sin motivo nuevo):**
ser **Resource Server puro**. El Authorization Server se ALQUILA (Auth0 /
WorkOS / Clerk / Stytch — el que elija el dueño; requisito no negociable:
**Dynamic Client Registration**, RFC 7591, porque ChatGPT y Claude se dan de
alta solos y sin DCR no hay conexión posible). Construir `/authorize`, PKCE,
refresh, consent y DCR propios es semanas de trabajo en el lugar donde viven
todas las CVEs de este espacio, y no es el producto.

**Fase 3a — Resource Server (M):**

1. `/.well-known/oauth-protected-resource` (RFC 9728) servido por el transporte
   HTTP, apuntando al AS elegido. El `WWW-Authenticate` con `resource_metadata`
   va en el 401 que **ya existe** en `transport/http.ts` (la línea del
   `www-authenticate` ya está; se le agrega el parámetro).
2. Validación de JWT: firma contra el JWKS del AS (cachear las claves), `iss`,
   `exp`, y **`aud` == la URL canónica de este server**. La validación de `aud`
   no es opcional: es lo único que impide que un token emitido para otro
   servicio sirva acá (confused deputy). Rechazo mudo: "Token inválido.", sin
   decir si existe.
3. El mapeo identidad → empresa vive **adentro de `autenticarConTenants`**
   (`src/tenants/acceso.ts`) como segunda rama de la MISMA función. El
   encabezado de ese módulo ya explica por qué autenticación y selección de
   tenant son una sola decisión — OAuth no afloja eso, lo hereda. Un `sub`/
   `org_id` que no mapea a un tenant es 401, nunca "tenant default".
4. El `auth_token` estático **sigue funcionando** (Kapso no habla OAuth). Dos
   modalidades, un mismo `Tenant` de salida.
5. El mapeo `org_id → tenant.id` se guarda en el registro: campo opcional
   `oauth_org` en la entrada del tenant (validado único, como el resto).
   `construirRegistro` gana ese campo y un índice `porOrg`.

**Fase 3b — el registro sale del JSON (M), solo cuando 3a esté en producción:**
`BILLER_TENANTS_PATH` aguanta decenas de empresas. La base (Postgres/Turso)
entra cuando el alta la haga OTRO (self-service), no antes. Lo que se mueve es
EL CARGADOR (`cargarTenants` gana una fuente), no la forma: cada fila guarda su
`env` como JSON y `entornoDe`/`construirRegistro` no cambian una línea. Con la
base, los tokens de Biller quedan en una base: **cifrado en reposo con la clave
fuera de la base** es lo que hace que esta fase no sea "mover un JSON".

**Fase 3c — alta como servicio (L):** el formulario/endpoint de alta con
autenticación de OPERADOR (distinta de la de tenant), que llama a la misma
lógica que `--crear`. Requiere Fase 2 (sin recarga en caliente el formulario
promete lo que no puede cumplir) y 3a (sin OAuth no hay a quién autenticar como
operador).

**Escritura remota: LO ÚLTIMO, y con un diseño previo.** Hoy
`identidadDeConversacion` (`src/security/remitentes.ts`) ancla el ciclo
dry-run → token → confirm al remitente verificado de WhatsApp. En un cliente
web no hay remitente: sin un equivalente, "quien tiene el access token del
tenant" confirma lo que otro previsualizó — el agujero intra-empresa que se
cerró en agosto, reabierto. El candidato natural es el `sub` del JWT (misma
decisión, mismo lugar: `identidadDeConversacion` gana una rama). Hasta que ese
diseño esté escrito y testeado: **remoto = solo lectura**, que es además lo que
`resolverCapabilityModeServerless` ya hace solo.

**Criterios de aceptación de la Fase 3a:**
- ChatGPT (developer mode) y Claude web conectan contra el server de test con
  login y listan las 27 tools.
- Un JWT con `aud` de otro servicio → 401. Un `sub` sin tenant → 401 mudo.
- Kapso sigue entrando con su `auth_token` estático, sin cambios.
- `tests/tenants.test.ts` cubre el mapeo `porOrg` (único, no heredable).
- Ninguna tool ni barrera cambió: `crearServidorMcp` no se entera de OAuth.

## Lo que NO hay que hacer (vale para todas las fases)

1. No construir Authorization Server propio.
2. No agregar jamás un header/parámetro de tenant — la credencial ES el selector
   (`registry.ts` explica por qué; sigue siendo cierto con OAuth).
3. No pasar el token de Biller por OAuth ni devolverlo en claims.
4. No habilitar escritura en serverless para "probar".
5. No autocompletar ninguna de las cuatro barreras humanas en ningún alta.
6. Nada transversal "que cada tool se acuerde": todo por `registerTool`.
