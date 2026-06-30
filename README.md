# Biller MCP server

MCP server **local** para la API REST de [Biller](https://biller.uy) (facturación
electrónica de Uruguay). Permite que asistentes como Claude Desktop / Claude Code
consulten y operen Biller de forma conversacional.

Tiene **dos modos operativos** (controlados por `BILLER_CAPABILITY_MODE`):

- **`read_only` (default):** solo las 6 tools de lectura se registran en el
  servidor MCP. Solo `GET`. Modo seguro para producción y uso sin riesgo.
- **`write_enabled`:** se agregan las 6 tools de escritura (`POST`) —
  protegidas por dry-run + confirmación + gate de ambiente + idempotencia + audit.
  La **ejecución real** del `POST` además requiere `BILLER_WRITE_ENABLED=true`.

- Stack: TypeScript + Node.js, `@modelcontextprotocol/sdk`, Zod, Vitest. Transporte: **stdio**.
- Fuente de verdad de endpoints/campos:
  **[OpenAPI público de Biller](https://francodest-biller-v3-docs.apidocumentation.com/openapi.json)**.

> ⚠️ **Advertencia fiscal.** Emitir o anular un CFE tiene consecuencias **reales e
> irreversibles** ante DGI. La escritura está **apagada por defecto**
> (`BILLER_WRITE_ENABLED` no seteado) y, aun encendida, exige confirmación
> explícita por operación. **Probá siempre primero en `https://test.biller.uy`.**

---

## Qué hace

**Lectura**
- Lista **comprobantes emitidos** (`GET /v2/comprobantes/obtener`).
- Obtiene **un comprobante** por `id`, `numero_interno` o terna `tipo+serie+numero`.
- Lista **comprobantes recibidos** DGI (`GET /v2/comprobantes/recibidos/obtener`).
- **Resumen de facturación por período** (totales por moneda y tipo; ventas suman,
  NC restan, ND suman; **no convierte monedas**).
- **Datos DGI por RUT** (nombre, datos de entidad, actividad, certificado único).
- **Health check** (no llama a Biller, nunca revela el token).

**Escritura (con barreras, ver más abajo)**
- **Emitir** comprobante (`POST /v2/comprobantes/crear`).
- **Anular** comprobante (`POST /v2/comprobantes/anular`).
- **Crear cliente** (`POST /v2/clientes/crear`).
- **Cargar producto/servicio** (`POST /v2/productos/cargar`).
- **Crear recibo** (`POST /v2/recibos/crear`).
- **Cancelar recibo** (`POST /v2/recibos/cancelar`).

## Qué NO hace

- ❌ No ejecuta ninguna escritura **sin** `BILLER_WRITE_ENABLED=true` **y**
  confirmación explícita por operación (el preview/dry-run sí está siempre).
- ❌ No escribe en **producción** sin doble habilitación (env + `allow_production`).
- ❌ No convierte monedas (no asume tipo de cambio).
- ❌ No lista clientes propios de Biller (no hay endpoint GET documentado de listado).
- ❌ No expone el endpoint PDF en el MVP.
- ❌ No loguea ni devuelve `BILLER_API_TOKEN`; no escribe el payload completo en el audit.

---

## Tools disponibles

**Lectura (read-only)**

| Tool | Endpoint | Notas |
|---|---|---|
| `biller_health_check` | — | Diagnóstico. Reporta `mode`/`environment`. Nunca expone el token. |
| `biller_buscar_cliente_por_rut` | `/v2/dgi/empresas/*` | Datos DGI. `es_cliente_biller_confirmado` siempre `null`. |
| `biller_listar_comprobantes_emitidos` | `/v2/comprobantes/obtener` | Filtros `moneda`/`cliente_rut`/`limit` locales. |
| `biller_listar_comprobantes_recibidos` | `/v2/comprobantes/recibidos/obtener` | Solo montos totales (sin items). |
| `biller_obtener_comprobante` | `/v2/comprobantes/obtener` | Por `id`, `numero_interno` o terna. |
| `biller_resumen_facturacion_periodo` | `/v2/comprobantes/obtener` | Totales por moneda/tipo. No convierte. |

**Escritura (`readOnlyHint:false`, `destructiveHint:true`)**

| Tool | Endpoint |
|---|---|
| `biller_emitir_comprobante` | `POST /v2/comprobantes/crear` |
| `biller_anular_comprobante` | `POST /v2/comprobantes/anular` |
| `biller_crear_cliente` | `POST /v2/clientes/crear` |
| `biller_cargar_producto` | `POST /v2/productos/cargar` |
| `biller_crear_recibo` | `POST /v2/recibos/crear` |
| `biller_cancelar_recibo` | `POST /v2/recibos/cancelar` |

`biller_listar_clientes` (listado GET de clientes) **no se registra**: no hay
endpoint GET documentado (ver [Pendientes](#pendientes-de-validación-contra-biller)).

---

## Escritura con barreras

Cada tool de escritura funciona en **dos fases**:

**1. Dry-run (default, `confirm` ausente o `false`)** — valida el cuerpo, arma el
payload exacto, y devuelve un **preview** + un `confirmation_token`.
**No hace ninguna llamada de red.**

```jsonc
{
  "mode": "dry_run",
  "endpoint": "/v2/comprobantes/crear",
  "environment": "test",
  "write_enabled": false,
  "gate": { "allowed": false, "reason": "write_disabled", "requires_allow_production": false },
  "payload_preview": { "tipo_comprobante": 101, "sucursal": 6, "items": [ /* ... */ ] },
  "confirmation_token": "a1b2…(sha256)",
  "next_step": "Para EJECUTAR, volvé a llamar … con confirm=true y confirmation_token=\"a1b2…\"",
  "no_network_call": true,
  "warnings": []
}
```

**2. Ejecución (`confirm: true` + `confirmation_token`)** — recién acá puede hacer el
`POST`, y solo si pasan **todas** las barreras:

1. **Token**: el `confirmation_token` debe coincidir con el payload+endpoint+ambiente.
   Si cambiás cualquier campo, el token deja de valer → hay que volver a previsualizar.
2. **Gate de escritura**: `BILLER_WRITE_ENABLED=true`.
3. **Gate de producción**: si el ambiente es `production`, además
   `BILLER_ALLOW_PRODUCTION_WRITES=true` **y** el argumento `allow_production=true`.
4. **Idempotencia**: una misma `idempotency_key` no se ejecuta dos veces en la sesión
   (también se envía como header `Idempotency-Key`).
5. **Audit log**: cada intento/ejecución se registra (a stderr y, opcional, a archivo)
   con `audit_id`, endpoint, ambiente, hash del payload y estado — **nunca** el token
   ni el payload completo.

Flujo típico con el asistente: pedís la operación → el MCP devuelve el **preview** →
revisás → confirmás → el asistente reenvía con `confirm:true` + token → se ejecuta.

---

## Instalación

Requisitos: **Node.js ≥ 18.17** (usa `fetch` nativo).

```bash
git clone <este-repo>
cd MCP_Biller
npm install
npm run build
```

## Configuración (`.env`)

Copiá `.env.example` a `.env`. **Empezá siempre por TEST.** El `.env` está en
`.gitignore`; no commitees tokens.

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `BILLER_API_BASE_URL` | ✅ | — | `https://test.biller.uy` o `https://biller.uy`. |
| `BILLER_API_TOKEN` | ✅ | — | Bearer token de la empresa. Nunca se loguea ni se devuelve. |
| `BILLER_CAPABILITY_MODE` | ❌ | `read_only` | `read_only` (solo lectura) \| `write_enabled` (+ tools de escritura). |
| `BILLER_DEFAULT_EMPRESA_RUT` | ❌ | — | Metadata local; **no** se envía a la API. |
| `BILLER_DEFAULT_SUCURSAL_ID` | ❌ | — | Default de `sucursal` (lectura y emisión). |
| `BILLER_TIMEOUT_MS` | ❌ | `30000` | Timeout HTTP (ms). |
| `LOG_LEVEL` | ❌ | `info` | `error`\|`warn`\|`info`\|`debug` (logs a **stderr**). |
| `BILLER_WRITE_ENABLED` | ❌ | `false` | Gate de ejecución POST. Sin esto, solo dry-run (requiere `write_enabled`). |
| `BILLER_ALLOW_PRODUCTION_WRITES` | ❌ | `false` | Habilita POST contra producción (+ `allow_production=true`). |
| `BILLER_AUDIT_LOG_PATH` | ❌ | — | Archivo opcional para el audit log de escrituras. |

## Build, test y guard

```bash
npm run build          # tsc -> dist/
npm test               # vitest (mocks; sin red real)
npm run typecheck      # tsc --noEmit
npm run check:readonly # falla si hay POST/PUT/PATCH/DELETE FUERA de la capa write/
```

---

## Conectar a Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```jsonc
{
  "mcpServers": {
    "biller": {
      "command": "node",
      "args": ["/ruta/ABSOLUTA/MCP_Biller/dist/index.js"],
      "env": {
        "BILLER_API_BASE_URL": "https://test.biller.uy",
        "BILLER_API_TOKEN": "tu-token-de-TEST",
        "BILLER_DEFAULT_SUCURSAL_ID": "1",
        "BILLER_WRITE_ENABLED": "false"
      }
    }
  }
}
```

Para **habilitar escritura en test**: agregá `"BILLER_CAPABILITY_MODE": "write_enabled"` y
`"BILLER_WRITE_ENABLED": "true"`. Aun así, cada emisión/anulación requiere el flujo
dry-run → confirm con token.

## Conectar a Claude Code

```bash
npm run build
claude mcp add biller \
  --env BILLER_API_BASE_URL=https://test.biller.uy \
  --env BILLER_API_TOKEN=tu-token-de-TEST \
  --env BILLER_DEFAULT_SUCURSAL_ID=1 \
  -- node /ruta/ABSOLUTA/MCP_Biller/dist/index.js
```

## Probar con MCP Inspector

```bash
npm run inspector   # = npm run build && npx @modelcontextprotocol/inspector node dist/index.js
```

Probá `biller_health_check` (mirá `capability_mode`/`write_tools_registered`/`environment`).
Para probar escritura, pasá `BILLER_CAPABILITY_MODE=write_enabled` al inspector y verificá
que aparezcan las tools de escritura. Después llamá `biller_emitir_comprobante` en
**dry-run** y verificá el `confirmation_token`.

---

## Seguridad y límites

- **Aislamiento de escritura**: todo el código que hace `POST` vive en `src/write/`.
  El guard estático (`npm run check:readonly` + `tests/readonly.test.ts`) falla si
  aparece escritura en cualquier otro lado: la superficie de lectura es GET-only.
- **Escritura apagada por defecto** + dry-run + confirmación + doble gate de
  producción + idempotencia + audit log.
- **Token protegido**: nunca se loguea ni se devuelve; se redacta de los errores
  (`[REDACTED]`). El audit guarda un **hash** del payload, no el payload.
- **stdout reservado** para MCP; los logs van a **stderr**.
- **Rate limits** (Biller): **1 req/seg** para DGI, recibidos y creación/anulación de
  comprobantes y recibos; **30 req/seg** para el resto. El `429` se mapea claro.
- **Sin conversión de monedas**.

---

## Pendientes de validación contra Biller

No documentado en el OpenAPI público (no se inventó):

1. **Endpoint GET de listado de clientes** → `biller_listar_clientes` no se registra.
   (Sí existe la escritura `biller_crear_cliente`.)
2. **Paginación** de `/v2/comprobantes/obtener` → `limit` es recorte local;
   `pagination_supported: false`.
3. **Campo de estado/anulación en emitidos** → no se pueden excluir anulados (warning).
4. **Estructura real de `cliente` en emitidos** → ejemplo `[]`; filtro `cliente_rut`
   solo si es extraíble.
5. **Filtros nativos de moneda/cliente** → se hacen locales.
6. **Semántica de fechas** (`desde`/`hasta`) → documentadas como `fecha_creacion`.
7. **Soporte del header `Idempotency-Key`** server-side → la idempotencia fuerte es
   in-process; el header es best-effort.
8. **Esquemas de request de los POST** → el OpenAPI solo trae **ejemplos** (no schema
   estricto); las tools validan los campos requeridos visibles y dejan pasar el resto.

## Roadmap

- Tool de PDF (`/v2/comprobantes/pdf`) con manejo de base64.
- Resource MCP con catálogo de tipos de CFE.
- Validar paginación / filtros nativos / endpoints de clientes cuando existan.
- Transporte Streamable HTTP.

## Fuente

OpenAPI: <https://francodest-biller-v3-docs.apidocumentation.com/openapi.json>
