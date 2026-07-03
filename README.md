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

> **Advertencia fiscal.** Emitir o anular un CFE tiene consecuencias **reales e
> irreversibles** ante DGI. La escritura está **apagada por defecto**
> (`BILLER_WRITE_ENABLED` no seteado) y, aun encendida, exige confirmación
> explícita por operación. **Probá siempre primero en `https://test.biller.uy`.**

---

## Qué hace

**Lectura**
- Lista **comprobantes emitidos** (`GET /v2/comprobantes/obtener`), con todos los
  campos reales que devuelve Biller (ver [Campos del comprobante](#campos-del-comprobante-lectura)).
- Obtiene **un comprobante** por `id`, `numero_interno` o terna `tipo+serie+numero`
  (con `id` incluye el detalle de `items[]` tipado).
- Lista **comprobantes recibidos** DGI (`GET /v2/comprobantes/recibidos/obtener`).
- **Resumen de facturación por período** (totales por moneda y tipo; ventas suman,
  NC restan, ND suman). Mantiene los totales separados por moneda e incluye
  `conteo_por_estado`.
- **Datos DGI por RUT** (nombre, datos de entidad, actividad, certificado único).
- **Health check** (no llama a Biller, nunca revela el token).

**Escritura (con barreras, ver más abajo)**
- **Emitir** comprobante (`POST /v2/comprobantes/crear`).
- **Anular** comprobante (`POST /v2/comprobantes/anular`).
- **Crear cliente** (`POST /v2/clientes/crear`).
- **Cargar producto/servicio** (`POST /v2/productos/cargar`).
- **Crear recibo** (`POST /v2/recibos/crear`).
- **Cancelar recibo** (`POST /v2/recibos/cancelar`).

## Límites

- Las tools de escritura no ejecutan `POST` sin `BILLER_WRITE_ENABLED=true` y
  confirmación explícita por operación. El preview/dry-run está disponible aunque
  la escritura real esté apagada.
- En producción, la escritura requiere doble habilitación: variable de entorno y
  argumento `allow_production`.
- El resumen de facturación no consolida monedas. Los importes se devuelven
  separados por moneda; el campo `tasa_cambio` se expone en los comprobantes
  cuando Biller lo devuelve.
- No hay tool de listado de clientes porque el OpenAPI público no documenta un
  endpoint GET para esa operación.
- No implementa descarga de PDF.
- No loguea ni devuelve `BILLER_API_TOKEN`; el audit no guarda el payload completo.

---

## Tools disponibles

**Lectura (read-only)**

| Tool | Endpoint | Notas |
|---|---|---|
| `biller_health_check` | — | Diagnóstico. Reporta `mode`/`environment`. Nunca expone el token. |
| `biller_buscar_cliente_por_rut` | `/v2/dgi/empresas/*` | Datos DGI. `es_cliente_biller_confirmado` siempre `null`. |
| `biller_listar_comprobantes_emitidos` | `/v2/comprobantes/obtener` | Filtros locales `moneda`/`cliente_rut`/`limit` y `emitidas_desde`/`emitidas_hasta` (por fecha de **emisión** fiscal). |
| `biller_listar_comprobantes_recibidos` | `/v2/comprobantes/recibidos/obtener` | Solo montos totales (sin items). |
| `biller_obtener_comprobante` | `/v2/comprobantes/obtener` | Por `id`, `numero_interno` o terna. Con `id` trae `items[]` tipado. |
| `biller_resumen_facturacion_periodo` | `/v2/comprobantes/obtener` | Totales por moneda/tipo + `conteo_por_estado`. Filtros locales por fecha de emisión. |

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

## Campos del comprobante (lectura)

El OpenAPI público documenta ~18 campos, pero la **API real devuelve ~35**. El
normalizador los expone todos con tipos estables (los números llegan como string,
p.ej. `"38.397"`, y se convierten a número). Lo más útil:

| Campo | Tipo | Notas |
|---|---|---|
| `estado` | string | Estado ante DGI: `"Aceptado DGI"`, `"Rechazado DGI"`, `"Sobre Rechazado DGI"`, `"Pendiente DGI"`, `"Envío no corresponde"`. **No** documentado en el OpenAPI. |
| `tasa_cambio` | number | Cotización del día para moneda extranjera (ej. USD `38.397`). En UYU = `1`. |
| `sucursal` | number | ID real de la sucursal emisora. |
| `numero_interno` | string\|null | Identificador propio de la empresa. |
| `moneda` / `total` | string→number | Moneda y total del comprobante. |
| `montos_brutos` | number | Flag `0/1`: si los precios de los ítems incluyen IVA. |
| `iva` | objeto | Subtotales por tasa (`tasa_minima`/`tasa_basica`/`tasa_otra`). |
| `adenda`, `informacion_adicional`, `numero_orden`, `lugar_entrega` | string | Texto libre del comprobante. |
| `razon_referencia`, `referencia_global`, `retenciones_percepciones` | varios | Referencias a otros CFE y retenciones. |
| `cliente` | objeto crudo | Receptor (id, tipo_documento, documento/RUT, razon_social, sucursal). |
| `items` | array | Solo al consultar con `id`. Cada ítem: `codigo`, `concepto`, `cantidad`, `precio`, `indicador_facturacion`, `impuesto_tasa`, descuentos/recargos y `retenciones_percepciones`. |
| `campos_presentes` | string[] | Todas las claves crudas que vinieron en la respuesta. |
| `campos_extra` | objeto | **Red de seguridad**: cualquier campo que la API devuelva y el normalizador aún no tipe aparece acá (no se pierde nada). |

> **Estado y facturación.** El `resumen_facturacion_periodo` **suma todos los
> estados** y agrega `conteo_por_estado` + un warning si el total incluye
> `Rechazado DGI`/`Pendiente DGI`. **No existe un estado "Anulado"**: anular un CFE
> genera una Nota de Crédito separada (que ya resta en el total).

> **Fechas.** Los filtros `desde`/`hasta` de la API filtran por **fecha de
> creación** (carga en Biller). Para acotar por **fecha de emisión** fiscal usá los
> filtros locales `emitidas_desde`/`emitidas_hasta` (avisan si excluyen comprobantes
> sin `fecha_emision`).

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
git clone https://github.com/MateoFabregat/MCP_Biller.git
cd MCP_Biller
npm ci
cp .env.example .env
npm run build
```

Completar `.env` con `BILLER_API_BASE_URL` y `BILLER_API_TOKEN`. Para pruebas,
usar `https://test.biller.uy` y dejar `BILLER_CAPABILITY_MODE=read_only`.

Hay un ejemplo de configuración para Claude Desktop en
[`claude_desktop_config.example.json`](./claude_desktop_config.example.json).

## Configuración (`.env`)

Copiá `.env.example` a `.env`. **Empezá siempre por TEST.** El `.env` está en
`.gitignore`; no commitees tokens.

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `BILLER_API_BASE_URL` | Sí | — | `https://test.biller.uy` o `https://biller.uy`. |
| `BILLER_API_TOKEN` | Sí | — | Bearer token de la empresa. Nunca se loguea ni se devuelve. |
| `BILLER_CAPABILITY_MODE` | No | `read_only` | `read_only` (solo lectura) \| `write_enabled` (+ tools de escritura). |
| `BILLER_DEFAULT_EMPRESA_RUT` | No | — | Metadata local; **no** se envía a la API. |
| `BILLER_DEFAULT_SUCURSAL_ID` | No | — | Default de `sucursal` (lectura y emisión). **ID real** de Biller (Ajustes → Sucursales), no un valor genérico. Opcional: `obtener` no lo exige. |
| `BILLER_TIMEOUT_MS` | No | `30000` | Timeout HTTP (ms). |
| `LOG_LEVEL` | No | `info` | `error`\|`warn`\|`info`\|`debug` (logs a **stderr**). |
| `BILLER_WRITE_ENABLED` | No | `false` | Gate de ejecución POST. Sin esto, solo dry-run (requiere `write_enabled`). |
| `BILLER_ALLOW_PRODUCTION_WRITES` | No | `false` | Habilita POST contra producción (+ `allow_production=true`). |
| `BILLER_AUDIT_LOG_PATH` | No | — | Archivo opcional para el audit log de escrituras. |

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
        "BILLER_WRITE_ENABLED": "false"
      }
    }
  }
}
```

`BILLER_DEFAULT_SUCURSAL_ID` es **opcional** y se omite arriba a propósito:
`GET /v2/comprobantes/obtener` no requiere sucursal. Si querés fijar una por
defecto, usá el **ID real** de tu sucursal (Ajustes → Sucursales en
`{ambiente}.biller.uy`), **no** un valor genérico como `1`.

Para **habilitar escritura en test**: agregá `"BILLER_CAPABILITY_MODE": "write_enabled"` y
`"BILLER_WRITE_ENABLED": "true"`. Aun así, cada emisión/anulación requiere el flujo
dry-run → confirm con token.

## Conectar a Claude Code

```bash
npm run build
claude mcp add biller \
  --env BILLER_API_BASE_URL=https://test.biller.uy \
  --env BILLER_API_TOKEN=tu-token-de-TEST \
  -- node /ruta/ABSOLUTA/MCP_Biller/dist/index.js
# Opcional: --env BILLER_DEFAULT_SUCURSAL_ID=<ID real de Ajustes → Sucursales>
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
- El resumen de facturación mantiene los totales separados por moneda. No calcula
  un total consolidado en UYU/USD.

---

## Pendientes de validación contra Biller

No documentado en el OpenAPI público (no se inventó):

1. **Endpoint GET de listado de clientes** → `biller_listar_clientes` no se registra.
   (Sí existe la escritura `biller_crear_cliente`.)
2. **Paginación** de `/v2/comprobantes/obtener` → `limit` es recorte local;
   `pagination_supported: false`.
3. **Estado de anulación** → la API expone `estado` (Aceptado/Rechazado/Pendiente DGI),
   pero **no** un estado "Anulado": anular genera una Nota de Crédito separada. El
   resumen lo aclara y desglosa por estado en vez de intentar filtrar anulados.
4. **Estructura real de `cliente` en emitidos** → se preserva cruda; el filtro
   `cliente_rut` la recorre buscando el `documento`/RUT.
5. **Filtros nativos de moneda/cliente** → se hacen locales.
6. **Semántica de fechas** (`desde`/`hasta`) → filtran por `fecha_creacion`. Para la
   fecha de **emisión** fiscal hay filtros locales `emitidas_desde`/`emitidas_hasta`.
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
