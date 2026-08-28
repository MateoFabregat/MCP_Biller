# Plan plug-and-play: de "un comando por empresa" a "cada empresa desde su propio Claude/ChatGPT"

Estado al 28/08/2026. La Fase 1 está **implementada** (`onboard --crear`); este
documento es el handoff de las Fases 2 y 3 para quien las ejecute. Antes de
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

## Fase 2 — Recarga en caliente del registro (est. 1–2 días)

**El problema:** `cargarTenants` corre UNA vez en `src/index.ts`. Dar de alta
una empresa = reiniciar el proceso = corte para todas las demás. Con esto, el
alta pasa a ser: `onboard --crear` + `kill -HUP <pid>`.

**Diseño (de menor a mayor riesgo):**

1. **`RegistroTenants` detrás de una referencia mutable con reemplazo atómico.**
   Hoy `iniciarTransporteHttp` recibe el registro por valor. Cambiarlo a un
   contenedor (`{ actual(): RegistroTenants }`) que el transporte consulte en
   cada request (la resolución por token ya recorre la lista completa en tiempo
   constante — `resolverTenant` — así que consultar la referencia no cambia el
   perfil de timing). El reemplazo: se carga y valida el registro NUEVO entero
   (`cargarTenants`), y **solo si valida** se publica con una asignación. Un
   registro inválido en disco NO baja nada: se loguea el error y sigue el
   anterior. Nunca un estado a medias.

2. **`SIGHUP` como disparador.** En `index.ts`, junto a los handlers de
   SIGINT/SIGTERM. NO un endpoint HTTP de reload — eso es superficie de ataque
   nueva para ahorrarse un ssh, y la Fase 3 lo va a hacer bien con identidad de
   operador.

3. **Invalidar `ContextosPorTenant` de los tenants cuyo `env` cambió.** ESTE ES
   EL PUNTO DELICADO. Un contexto viejo con el `IdempotencyStore` viejo y el
   token nuevo es exactamente el estado cruzado que el invariante 4 del HANDBOOK
   prohíbe. Regla: comparar el `env` serializado (con `stableStringify`, ya
   existe en utils) del tenant viejo vs. nuevo; si difiere, `contextos` descarta
   ese contexto (los archivos de persistencia quedan; el próximo request lo
   reconstruye). Un tenant que desaparece del registro pierde su contexto Y sus
   sesiones HTTP (`RegistroSesiones` ya tiene el cierre por desalojo —
   `cerrarTenant` está escrito y SIN llamador, `src/transport/http.ts`: este es
   su llamador). Un tenant que cambia de `auth_token` también: sesión vieja con
   credencial vieja no puede seguir viva.

4. **El webhook multi-empresa** resuelve por `porPhoneNumberId` — tiene que leer
   del contenedor, no de una captura del arranque. Revisar `resolverAmbitoWebhook`
   en `index.ts`.

**Tests que tienen que existir (la barrera es el test, no la intención):**
- Recarga con registro inválido → el server sigue atendiendo con el anterior.
- Tenant que cambia de `BILLER_API_TOKEN` → su contexto se reconstruye, los
  demás contextos son EL MISMO objeto (identidad, no igualdad).
- Tenant eliminado → sus sesiones HTTP mueren (request con su `mcp-session-id`
  → 404) y su `auth_token` deja de autenticar.
- Tenant agregado → atiende sin reinicio.
- El proceso mono-tenant (sin registro) ignora SIGHUP sin ruido.

**Archivos:** `src/index.ts`, `src/transport/http.ts` (recibir el contenedor),
`src/tenants/contextos.ts` (invalidación selectiva), `tests/tenants.test.ts` /
`tests/httpTransport.test.ts`.

**Qué NO hacer:** no recargar "por archivo watcheado" (fsevents + iCloud en
macOS = recargas fantasma; ya nos comimos los archivos " 2" — ver
`scripts/check-empaque.mjs`). No aceptar el registro nuevo si
`construirRegistro` lanza. No conservar contextos "por las dudas".

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

## Lo que NO hay que hacer (vale para las tres fases)

1. No construir Authorization Server propio.
2. No agregar jamás un header/parámetro de tenant — la credencial ES el selector
   (`registry.ts` explica por qué; sigue siendo cierto con OAuth).
3. No pasar el token de Biller por OAuth ni devolverlo en claims.
4. No habilitar escritura en serverless para "probar".
5. No autocompletar ninguna de las cuatro barreras humanas en ningún alta.
6. Nada transversal "que cada tool se acuerde": todo por `registerTool`.
