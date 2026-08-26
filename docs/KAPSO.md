# Integración con Kapso (WhatsApp)

> Estado: implementado y verificado contra el sandbox real de Kapso (texto,
> lista interactiva, botones y PDF adjunto, 28/07). Falta armar el flow con el
> Agent Node — ver §6.
>
> **Este documento es la plomería**: cómo se conecta el server a Kapso, con qué
> tokens y desplegado dónde. La **conversación** —qué pasa cuando llega un
> "hola", cómo se emite con botones, cómo llega el PDF— está en
> [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md), con el system prompt del Agent Node
> listo para copiar.

Hay **dos direcciones**, independientes entre sí, con arquitecturas de seguridad
opuestas. Se pueden habilitar por separado.

| | Inbound | Outbound |
|---|---|---|
| Qué hace | el dueño **pregunta** por WhatsApp y contesta el MCP | el sistema **avisa** solo |
| Quién inicia | el usuario | el server |
| Requiere | `BILLER_TRANSPORT=http` + URL pública | `KAPSO_API_KEY` + allowlist |
| Riesgo a controlar | autenticar la **entrada** | restringir la **salida** |

---

## 1. Inbound — preguntarle a Biller por WhatsApp

Los Agent Nodes de Kapso aceptan MCP servers externos vía `flow_agent_mcp_servers`.
Eso significa que **todas las tools que ya existen funcionan por WhatsApp sin
escribir una línea de lógica nueva**: el mismo código que contesta en Claude
Desktop contesta en el celular del dueño de la PyME.

### 1.1. El bloqueante y cómo se resolvió

Kapso rechaza URLs que resuelven a **localhost** (protección SSRF), y el server
era **stdio-only**. Se agregó transporte HTTP (`src/transport/http.ts`).

### 1.2. Arrancar el server en modo HTTP

```bash
export BILLER_TRANSPORT=http
export BILLER_HTTP_AUTH_TOKEN=$(openssl rand -hex 32)   # guardalo: lo necesita Kapso
export BILLER_API_BASE_URL=https://test.biller.uy
export BILLER_API_TOKEN=<tu-token-de-biller>
npm run build && npm start
```

El endpoint MCP queda en `http://127.0.0.1:8848/mcp`, y hay un `/healthz` sin
autenticación que solo devuelve `{"status":"ok","transport":"http"}` — ningún
dato del negocio.

**Sin `BILLER_HTTP_AUTH_TOKEN` el server no arranca.** No es tolerante como la
config de Biller: un endpoint HTTP sin credencial expone la contabilidad entera
a quien encuentre el puerto.

### 1.3. Darle una URL pública

`127.0.0.1` es el default a propósito. Dos caminos:

**Túnel (desarrollo):**

```bash
cloudflared tunnel --url http://localhost:8848
```

**Vercel (producción)** — ver §1.6. Es el camino elegido.

Si en cambio corrés el proceso vos mismo, poné un reverse proxy con TLS.
**No pongas el proceso directamente en `0.0.0.0` sin TLS**: el bearer viajaría
en texto plano. El server lo advierte en el log si detecta esa configuración.

### 1.4. Configurar el Agent Node

```json
{
  "flow_agent_mcp_servers": [
    {
      "name": "biller",
      "url": "https://<tu-tunel>.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer ${ENV:BILLER_HTTP_AUTH_TOKEN}" }
    }
  ]
}
```

Kapso soporta `${ENV:KEY}` en headers: **cargá el token como variable de entorno
del proyecto, no lo pegues literal en el JSON del flow.**

### 1.5. Deploy en Vercel

```bash
vercel --prod
```

El endpoint MCP para Kapso queda en `https://<tu-deploy>.vercel.app/api/mcp`.

Variables a cargar en el panel de Vercel (**nunca en un archivo**):

| Variable | Obligatoria |
|---|---|
| `BILLER_API_BASE_URL` | sí |
| `BILLER_API_TOKEN` | sí |
| `BILLER_HTTP_AUTH_TOKEN` | sí (`openssl rand -hex 32`) |
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_DESTINATARIOS_PERMITIDOS` | solo para el push |

#### Lo que cambia en serverless — leer antes de desplegar

Vercel congela o destruye el proceso entre invocaciones, y cada request puede
caer en una instancia distinta. Nada en memoria sobrevive de forma confiable.
Tres consecuencias reales:

1. **Modo stateless.** El transporte no emite `mcp-session-id`: un id emitido
   por una instancia no lo conoce la siguiente, y el cliente recibiría 404 en la
   segunda llamada. Con stateless cada request es independiente — que es
   exactamente el patrón de uso de Kapso.

2. **La escritura se DEGRADA a `read_only` automáticamente.** La idempotencia
   vive en memoria y en serverless no sobrevive; un reintento —rutina en
   serverless, no excepción— podría emitir dos veces la misma factura ante DGI.
   Para asumirlo igual hace falta `BILLER_SERVERLESS_ALLOW_WRITES=true`, cuyo
   nombre dice lo que estás aceptando. **La recomendación es dejar Vercel en
   read_only** y hacer la escritura desde un proceso con disco.

3. **`BILLER_AUDIT_LOG_PATH` y `BILLER_IDEMPOTENCY_LOG_PATH` no funcionan**: el
   filesystem es de solo lectura. El audit igual sale por stderr y Vercel lo
   captura en sus logs.

`/api/healthz` responde sin autenticación y devuelve solo booleanos de
configuración — nunca valores.

### 1.6. Verificar

```bash
curl -s http://127.0.0.1:8848/healthz
```

```bash
curl -s -X POST http://127.0.0.1:8848/mcp -H "authorization: Bearer $BILLER_HTTP_AUTH_TOKEN" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'
```

---

## 2. Outbound — que el sistema avise solo

Cuatro salidas, todas con la misma barrera (allowlist de destinatarios):

| Qué manda | Tool | Tipo de mensaje |
|---|---|---|
| El digest operativo | `biller_reporte_diario` (`enviar=true`) | texto |
| El menú de opciones | `biller_menu_whatsapp` (`enviar=true`) | interactivo (lista) |
| El preview de una emisión | `biller_emitir_comprobante` (`confirmar_por_whatsapp`) | interactivo (botones) |
| El PDF de un CFE | `biller_enviar_comprobante_whatsapp` | documento adjunto |

`biller_reporte_diario` arma el digest (urgente → cobranzas → facturación) y
puede enviarlo por WhatsApp.

```bash
export KAPSO_API_KEY=<api-key-del-proyecto>
export KAPSO_PHONE_NUMBER_ID=<id-del-numero-emisor>
export KAPSO_DESTINATARIOS_PERMITIDOS=59899123456
```

### 2.1. El envío es opt-in y con allowlist

Por defecto la tool **solo devuelve el texto**. Enviar requiere `enviar: true`
**y** que el destinatario esté en `KAPSO_DESTINATARIOS_PERMITIDOS`.

La allowlist no es una comodidad de configuración. El mensaje lleva montos, RUTs
y nombres de clientes. El número de destino podría venir de un campo de texto de
un comprobante (que escribe un tercero), de una alucinación del modelo, o de un
dígito mal copiado. **Con allowlist, esas tres cosas son un error de validación;
sin allowlist, son una fuga de datos fiscales a un desconocido.**

Un destinatario bloqueado no genera **ninguna** conexión de salida: el chequeo
va antes de construir la request.

### 2.2. Envío automático sin volverse ruido

```json
{ "enviar": true, "destinatario": "59899123456", "solo_si_hay_novedades": true }
```

Con `solo_si_hay_novedades`, si no hay nada que atender no se manda nada. Un
digest que llega todos los días sin novedad se deja de leer a la segunda semana
— y entonces el día que sí importa tampoco se lee.

---

## 3. Qué se probó y qué no

| | Estado |
|---|---|
| Transporte HTTP: initialize → sesión → `tools/list` → `tools/call` | ✅ verificado contra el server real |
| Rechazo sin token / con token inválido / sin token configurado | ✅ 401 / 401 / 403 |
| `/healthz` sin auth y sin datos del negocio | ✅ |
| Allowlist de destinatarios (incluye "no genera tráfico de red") | ✅ 19 tests |
| Armado del digest y su límite de tamaño | ✅ |
| Interactivos, subida de media y documento adjunto | ✅ 42 tests — ver [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md) §7 |
| Cliente de Kapso contra la API **real** | ✅ texto, lista interactiva, botones y documento (sandbox, 28/07) |
| Agent Node de Kapso conectado a este MCP | ❌ **no probado** — ver §5 |

Los tests del cliente de Kapso usan un `fetch` inyectado, pero la forma de la
request **ya no sale solo de la documentación**: los cuatro tipos de mensaje se
mandaron contra el sandbox real el 28/07 y volvieron con `message_id` (y con
`media_id` el documento). Ver [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md) §7.1.

---

## 4. Sandbox: lo que no se puede probar ahí

| Capacidad | Sandbox | Producción |
|---|---|---|
| Texto e interactivos | ✅ | ✅ |
| Templates | ❌ | ✅ |
| Envío batch | ❌ | ✅ |

Consecuencia de diseño: **el push proactivo fuera de la ventana de 24 h de
WhatsApp necesita templates**, y los templates no existen en sandbox. El digest
automático de las 8 AM solo va a funcionar de verdad con una cuenta de
producción. En sandbox se valida el flujo completo, no el horario.

---

## 5. Tu número de prueba

El número que pasaste, `+598095923567`, lleva el **prefijo nacional 0** que en
formato internacional NO va:

| | |
|---|---|
| Como se marca en Uruguay | 095 923 567 |
| Como lo pasaste | +598 095923567 → `598095923567` (12 dígitos) |
| **Formato correcto (E.164)** | **`59895923567`** (11 dígitos) |

Ya quedó configurado así en tu `.env` local (que está gitignoreado). Si se
cargara con el 0, el envío se rechazaría como "destinatario no autorizado" sin
más explicación — por eso `advertenciasDestinatarios()` detecta ese patrón y lo
reporta en `biller_health_check` con el número enmascarado.

---

## 6. Lo que falta para cerrar

1. ~~**Credenciales de un proyecto de Kapso.**~~ ✅ Listo: el cliente habló con
   la API real el 28/07 (texto, lista interactiva, botones y PDF adjunto).
2. ~~**Activar el número en el sandbox.**~~ ✅ Listo.
3. **Armar el flow con el Agent Node.** Ya no es a mano: `scripts/kapso-flow.mjs`
   lo crea vía la Platform API (`https://api.kapso.ai/platform/v1`), leyendo el
   system prompt de [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md) §5 y activando el
   trigger `inbound_message` para `KAPSO_PHONE_NUMBER_ID`. Lo único que le falta
   es la **URL pública** del MCP, que Kapso exige que no resuelva a localhost.

   ```bash
   ngrok http 8848
   node scripts/kapso-flow.mjs https://<host>/mcp
   ```

   Solo un workflow puede tener el trigger activo por número, así que correrlo
   dos veces actualiza el que hay en vez de duplicarlo.
4. **Templates de WhatsApp** para el digest proactivo real (§4). Requiere cuenta
   de producción de Kapso, que todavía no hay — el sandbox alcanza para validar
   el flujo completo dentro de la ventana de 24 h.
