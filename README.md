# Biller MCP server

MCP server **local** para la API REST de [Biller](https://biller.uy) (facturación
electrónica de Uruguay). Permite que asistentes como Claude Desktop / Claude Code
consulten y operen Biller de forma conversacional.

Tiene **dos modos operativos** (controlados por `BILLER_CAPABILITY_MODE`):

- **`read_only` (default):** solo las 27 tools de lectura se registran en el
  servidor MCP. Solo `GET`. Modo seguro para producción y uso sin riesgo.
- **`write_enabled`:** se agregan las 7 tools de escritura (`POST`) —
  protegidas por dry-run + confirmación + gate de ambiente + idempotencia + audit.
  La **ejecución real** del `POST` además requiere `BILLER_WRITE_ENABLED=true`.

- Stack: TypeScript + Node.js, `@modelcontextprotocol/sdk`, Zod, Vitest. Transporte: **stdio**.
- Fuente de verdad de endpoints/campos: la **documentación oficial de la API de
  Biller** (OpenAPI). La emisión de CFE vive en **`POST /v3/comprobantes/emitir`**;
  el resto de las operaciones sigue en `v2`.

> **Advertencia fiscal.** Emitir o anular un CFE genera un documento **real**
> ante DGI. No es irreversible —una venta mal emitida se anula con una Nota de
> Crédito, y si esa anulación fue el error, una Nota de Débito le devuelve
> validez al original— pero **cada corrección es otro comprobante**, con su
> numeración y su envío a DGI: se arregla, no se deshace. Por eso la escritura
> está **apagada por defecto** (`BILLER_WRITE_ENABLED` no seteado) y, aun
> encendida, exige confirmación explícita por operación.
> **Probá siempre primero en `https://test.biller.uy`.**

---

## Instalación (usuarios)

**Claude Desktop / Claude Code** — un solo comando, contesta tres preguntas
(ambiente, token, dónde registrarlo) y escribe la configuración por vos:

```bash
npx biller-mcp-server init
```

Queda en **solo lectura** contra el ambiente que elijas. La escritura se
habilita a mano, a conciencia (ver [Modos operativos](#qué-hace)).

**Como plugin de Claude Code** (trae además el skill de vocabulario
`biller-consultas`): dentro de `claude`, con `BILLER_API_TOKEN` en tu entorno:

```
/plugin marketplace add MateoFabregat/MCP_Biller
/plugin install biller@biller
```

**ChatGPT / Claude web y móvil** todavía no: requieren un servidor remoto con
OAuth (en el roadmap). Este paquete corre local por stdio.

---

## Qué hace

**Lectura**
- Lista **comprobantes emitidos** (`GET /v2/comprobantes/obtener`), con todos los
  campos reales que devuelve Biller (ver [Campos del comprobante](#campos-del-comprobante-lectura)).
- Obtiene **un comprobante** por `id`, `numero_interno` o terna `tipo+serie+numero`
  (con `id` incluye el detalle de `items[]` tipado).
- Descarga el **PDF** de un comprobante (`GET /v2/comprobantes/pdf`).
- Lista **comprobantes recibidos** DGI (`GET /v2/comprobantes/recibidos/obtener`).
- **Resumen de facturación por período**, con cortes por **sucursal**, día, mes,
  tipo, moneda o cliente (ver [Reportes](#reportes-cuánto-vendí-y-dónde)).
- **Vencimientos y aging**: qué vence esta semana y qué ya venció, por tramos y
  por cliente (ver [Vencimientos](#vencimientos-qué-tengo-que-cobrar)).
- **Cuenta corriente**: deuda **neta** por cliente y por factura — lo facturado a
  crédito menos lo cobrado, con recibos totales y parciales
  (ver [Cuenta corriente](#cuenta-corriente-quién-me-debe-plata)).
- **Alertas operativas**: comprobantes rechazados por DGI y CAEs por agotarse o
  vencer (ver [Alertas](#alertas-operativas)).
- **Datos DGI por RUT** (nombre, datos de entidad, actividad, certificado único).
- **Health check** (no llama a Biller, nunca revela el token).

**Escritura (con barreras, ver más abajo)**
- **Emitir** comprobante (`POST /v3/comprobantes/emitir`).
- **Anular** comprobante (`POST /v2/comprobantes/anular`).
- **Crear cliente** (`POST /v2/clientes/crear`).
- **Cargar producto/servicio** (`POST /v2/productos/cargar`).
- **Crear recibo** (`POST /v2/recibos/crear`).
- **Cancelar recibo** (`POST /v2/recibos/cancelar`).
- **Registrar pago** (`POST /v2/pagos/crear`).

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
- **La cobranza sí se lee, pero la imputación factura-por-factura puede ser
  estimada.** Los recibos son CFE y vuelven en `GET /v2/comprobantes/obtener` con
  `indicador_cobranza_propia = 1`, así que el **saldo por cliente es exacto**. Lo
  que el listado no trae es a qué factura se imputó cada cobro: `biller_cuenta_corriente`
  consulta cada recibo por `id` para averiguarlo y, si la API no lo devuelve, cae a
  **FIFO** (lo más viejo primero) declarándolo en `estrategia`. Ver [PLAN_V2](docs/PLAN_V2.md).
- No loguea ni devuelve `BILLER_API_TOKEN`; el audit no guarda el payload completo.

---

## Tools disponibles

**Lectura (read-only)**

| Tool | Endpoint | Notas |
|---|---|---|
| `biller_health_check` | — | Diagnóstico. Reporta `mode`/`environment`. Nunca expone el token, y sin un remitente autorizado tampoco el RUT, la URL de la API ni la ruta del audit log (salen como booleanos). |
| `biller_buscar_cliente_por_rut` | `/v2/dgi/empresas/*` | Datos DGI. `es_cliente_biller_confirmado` siempre `null`. |
| `biller_listar_comprobantes_emitidos` | `/v2/comprobantes/obtener` | Filtros locales `moneda`/`cliente_rut`/`limit` y `emitidas_desde`/`emitidas_hasta` (por fecha de **emisión** fiscal). |
| `biller_listar_comprobantes_recibidos` | `/v2/comprobantes/recibidos/obtener` | Solo montos totales (sin items). |
| `biller_obtener_comprobante` | `/v2/comprobantes/obtener` | Por `id`, `numero_interno` o terna. Con `id` trae `items[]` tipado. |
| `biller_obtener_pdf` | `/v2/comprobantes/pdf` | Representación impresa en base64. Por defecto solo devuelve metadatos: pedí `incluir_base64=true` para el archivo. |
| `biller_resumen_facturacion_periodo` | `/v2/comprobantes/obtener` | Totales del período con `agrupar_por`. Ver [Reportes](#reportes-cuánto-vendí-y-dónde). |
| `biller_vencimientos` | `/v2/comprobantes/obtener` | Aging por `fecha_vencimiento` + ranking de clientes. Monto **bruto**: no descuenta cobros. |
| `biller_cuenta_corriente` | `/v2/comprobantes/obtener` | Deuda **neta** (facturado − cobrado), por cliente y por factura. Recibos totales y parciales. |
| `biller_alertas_operativas` | `/v2/comprobantes/obtener` + `/v2/dgi/empresas/certificado-unico` | Rechazos DGI, CAE por agotarse/vencer, emisión tardía, racha sin facturar y certificado DGI. |
| `biller_plata_en_riesgo` | `/v2/comprobantes/obtener` | Las 6 alertas sobre el dinero: cliente en fuga, deudor grande, deuda hacia los 90 días, concentración en alza, mes por debajo, devoluciones disparadas. Cada una con acción y monto expuesto. |
| `biller_ranking_clientes` | `/v2/comprobantes/obtener` | Top, nuevos, dormidos, concentración (HHI) y ratio de notas de crédito. **"Nuevo" exige `detectar_nuevos=true`**: sin mirar antes del período no se puede saber, y `es_nuevo` viene en `null` en vez de adivinar. |
| `biller_ranking_productos` | `/v2/comprobantes/obtener` | Unidades e importe por producto + **dispersión de precios** entre clientes. N+1 acotado: declara `cobertura_importe_pct`. |
| `biller_ranking_sucursales` | `/v2/comprobantes/obtener` | Participación de cada local y su **evolución en puntos** contra el período anterior: muestra la sucursal que factura más y pesa menos. Nombres desde `BILLER_SUCURSALES_JSON`. |
| `biller_cohortes_clientes` | `/v2/comprobantes/obtener` | Retención por mes de alta: de los que entraron en marzo, cuántos siguen comprando. El "alta" es la primera compra **del rango** (Biller no expone fecha de alta), así que las primeras cohortes se marcan `posible_contaminada`. |
| `biller_comparar_periodos` | `/v2/comprobantes/obtener` | Variación por moneda, proyección de cierre (run-rate) y exposición cambiaria. |
| `biller_compras_proveedores` | `/v2/comprobantes/recibidos/obtener` | A quién le comprás y cuánto. Devengado, **no** pagado. |
| `biller_requisitos_comprobante` | — | *"¿Qué necesito para emitir esto?"* Devuelve los campos que faltan y **una** pregunta por vez. Sin red. Contempla la regla de las 5.000 UI. |
| `biller_emision_guiada` | — | El paso ANTERIOR a `requisitos`, para el chat: pregunta **a quién** se le factura y de ahí *deduce* el tipo de CFE (RUT → e-Factura, CI → e-Ticket). Devuelve una pregunta por vez con el mensaje tocable armado. Sin red. Ver [FLUJO_WHATSAPP.md](docs/FLUJO_WHATSAPP.md) §3. |
| `biller_plan_anulacion` | `/v2/comprobantes/obtener` | *"¿Cómo anulo esto?"* NC para anular, ND para revertir la anulación. Detecta si ya tiene una NC encima. |
| `biller_resolver_nombre` | `/v2/comprobantes/obtener` | *"Facturale a Distribuidora **Peres**"* → quién es. Resuelve un nombre escrito a mano —con typo, abreviado, sin el "S.R.L."— contra los clientes y productos REALES de la empresa. Ante la duda devuelve candidatos y **exige preguntar**, en vez de elegir. Ver [`services/resolver.ts`](src/services/resolver.ts). |
| `biller_reporte_diario` | varios | El digest operativo, listo para WhatsApp. Con `enviar=true` lo manda vía Kapso (solo a números de la allowlist). |
| `biller_catalogo_datos` | — | Qué se puede preguntar y qué **no**, con la cobertura de cada cosa. |
| `biller_metricas` | — | Cómo viene funcionando el asistente: qué proporción de mensajes cae en "no entendí", en qué paso se abandonan las emisiones, qué tools fallan. NO toca la API ni devuelve datos de facturación. Ver [Métricas](#métricas-cómo-sabemos-que-anda). |
| `biller_menu_whatsapp` | — | El menú del asistente por WhatsApp y el enrutador de lo que escribe el usuario. Con `enviar=true` lo manda como **lista interactiva** tocable. Ver [FLUJO_WHATSAPP.md](docs/FLUJO_WHATSAPP.md). |
| `biller_enviar_comprobante_whatsapp` | `/v2/comprobantes/obtener` + `/pdf` | Adjunta el **PDF** de un CFE emitido a un WhatsApp, con el detalle armado desde el comprobante. El archivo no pasa por el contexto del modelo. Allowlist obligatoria. |
| `biller_recordatorio_cobro` | `/v2/comprobantes/obtener` | Le manda **al cliente deudor** su saldo. Única tool cuyo destinatario no es el usuario: exige dry-run → `confirmation_token` → confirm, allowlist, y no repite el envío al mismo cliente el mismo día. Si la imputación es FIFO reclama el total **sin** detallar facturas. Un cliente por invocación: no manda en lote. |
| `biller_posicion_iva` *(opt-in)* | `/v2/comprobantes/obtener` + recibidos | IVA ventas − IVA compras. **No se registra por defecto**: se parece a una declaración jurada sin serlo (`BILLER_ENABLE_IVA_ESTIMADO=true`). |

**Escritura (`readOnlyHint:false`, `destructiveHint:true`)**

| Tool | Endpoint |
|---|---|
| `biller_emitir_comprobante` | `POST /v3/comprobantes/emitir` (acepta `confirmar_por_whatsapp`: manda el preview como botones ✅/✖️) |
| `biller_anular_comprobante` | `POST /v2/comprobantes/anular` |
| `biller_crear_cliente` | `POST /v2/clientes/crear` |
| `biller_cargar_producto` | `POST /v2/productos/cargar` |
| `biller_crear_recibo` | `POST /v2/recibos/crear` |
| `biller_cancelar_recibo` | `POST /v2/recibos/cancelar` |
| `biller_crear_pago` | `POST /v2/pagos/crear` |

`biller_listar_clientes` (listado GET de clientes) **no se registra**: no hay
endpoint GET documentado (ver [Pendientes](#pendientes-de-validación-contra-biller)).

> **Cómo se calcula cada número** — fórmula por fórmula, y qué parte usa IA
> (respuesta corta: ninguna): [`docs/CALCULOS.md`](docs/CALCULOS.md).
> **Arquitectura y diagramas:** [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).
> **La conversación por WhatsApp** — qué pasa cuando llega un "hola", cómo se
> emite con botones y cómo llega el PDF: [`docs/FLUJO_WHATSAPP.md`](docs/FLUJO_WHATSAPP.md).
> **Conexión con Kapso** (transporte HTTP, tokens, despliegue): [`docs/KAPSO.md`](docs/KAPSO.md).

---

## Reportes: cuánto vendí y dónde

`biller_resumen_facturacion_periodo` responde preguntas del tipo *"¿cuánto vendí
en cada local en junio?"*.

```jsonc
{ "periodo": "2026-06", "agrupar_por": ["sucursal"] }
```

**`periodo`** acepta `2026-06` (mes), `2026` (año), `2026-06-15` (día), `hoy`,
`ayer`, `mes_actual`, `mes_pasado`, `ultimos_7_dias`, `ultimos_30_dias`,
`ultimos_90_dias`, `anio_actual`. También podés pasar `desde`/`hasta` en `aaaa-mm-dd`.

**`agrupar_por`** admite `sucursal`, `dia`, `mes`, `tipo_comprobante`, `moneda`,
`cliente` y `estado`, y se pueden combinar (`["sucursal","mes"]` cruza local por mes).

Tres decisiones que hacen que los números **coincidan con Biller**:

1. **El período es por fecha de EMISIÓN fiscal.** Los parámetros `desde`/`hasta`
   de la API filtran por fecha de *creación* (carga en Biller), así que una venta
   del 30/06 cargada el 02/07 quedaría afuera. La tool consulta por creación con
   un margen y después filtra localmente por emisión.
2. **`solo_aceptados` viene en `true`.** El total cuenta solo los comprobantes en
   estado `"Aceptado DGI"`, que es el criterio con el que Biller muestra sus
   totales. El total con todos los estados igual se devuelve en
   `totales_por_moneda_todos_los_estados` para comparar.
3. **Los rangos largos se parten en ventanas** de 7 días (ajustable con
   `ventana_dias`) y se unen deduplicando por `id`: la API no pagina y devuelve
   500 con rangos amplios.

Para que los grupos digan `Sucursal 6 (Pocitos)` en vez de `Sucursal 6`,
configurá `BILLER_SUCURSALES_JSON` (Biller no expone un endpoint de sucursales).

---

## Vencimientos: qué tengo que cobrar

`biller_vencimientos` responde *"¿qué facturas vencen esta semana?"* y *"¿quién
me debe más?"*.

```jsonc
{ "horizonte_dias": 7 }        // lo que vence en los próximos 7 días + lo ya vencido
```

Devuelve el detalle de facturas ordenado de la más vencida a la más lejana, los
totales por moneda separados en **vencido** y **por vencer**, el aging por tramos
(1-30, 31-60, 61-90, +90 días) y un ranking `por_cliente` con el monto vencido y
los días de atraso máximo.

> ⚠️ **Es el monto bruto, no la deuda neta.** Esta tool no descuenta los cobros:
> una factura ya cobrada aparece igual. Los recibos se detectan y se excluyen del
> listado (cobrar un recibo no tiene sentido), y si hay alguno en la ventana la
> respuesta avisa que el monto mostrado sobra. `cobranzas_imputadas` es siempre
> `false`. **Para la deuda real usá `biller_cuenta_corriente`.**

Tres decisiones que conviene conocer:

1. **`dias_atras` (default 180)** es la ventana de emisión que se consulta. Una
   factura que vence esta semana pudo emitirse hace meses; si trabajás con plazos
   más largos, subilo (cada 7 días es una llamada más a la API).
2. **`solo_a_credito` viene en `true`**: descarta el contado con la heurística
   `fecha_vencimiento <= fecha_emision`, porque Biller no expone la forma de pago
   en el GET. Pasá `false` para incluirlo.
3. **Solo cuentan ventas y notas de débito.** Las notas de crédito restan deuda,
   no se cobran, así que no se listan como cobrables.

## Cuenta corriente: quién me debe plata

`biller_cuenta_corriente` responde lo que vencimientos no puede: **lo facturado a
crédito menos lo cobrado**, por cliente y por factura.

La clave es que **un recibo es un CFE**: se emite como e-Ticket (101) o e-Factura
(111) y vuelve en el mismo `GET /v2/comprobantes/obtener`, marcado con
`indicador_cobranza_propia = 1`. Puede ser **total, parcial o un "Adelanto"** sin
referencias. Con eso, facturas, notas de crédito y cobros salen de una sola
consulta.

```jsonc
{ "dias_atras": 365 }          // toda la deuda abierta del último año
{ "cliente_rut": "217832560011" }  // el estado de cuenta de un cliente
```

Devuelve por cada factura `total`, `cobrado`, `saldo` y `estado_cobro`
(`pendiente` / `parcial` / `cancelada`), el aging calculado sobre el **saldo neto**,
y un ranking `por_cliente` con saldo, vencido y días de atraso.

**Dos niveles de precisión, y la respuesta dice cuál usó** (`estrategia`):

| Nivel | Precisión | Costo |
|---|---|---|
| Saldo **por cliente** | **Exacto** siempre | 0 llamadas extra |
| Saldo **por factura** | Exacto si `estrategia: "referencias"`; estimado si `"fifo"`/`"mixta"` | 1 llamada por recibo |

El listado no trae a qué factura se imputó cada cobro, así que la tool consulta
cada recibo por `id` (N+1 **solo sobre recibos**, que son bastantes menos que las
facturas; apagable con `imputar_por_referencias=false`). Si la API no devuelve las
referencias, imputa **FIFO** —lo más viejo primero dentro de cada cliente+moneda,
el criterio contable estándar— y lo declara como estimación en `estrategia` y en
los warnings.

El cobro que no entra en ninguna factura abierta (un adelanto, o una factura
anterior a la ventana) **no se fuerza**: va a `saldo_a_favor_por_moneda`. Bajar el
saldo con plata que no le corresponde a esa factura sería peor que no imputarla.

## Alertas operativas

`biller_alertas_operativas` barre un período y devuelve lo que hay que atender,
usando campos que la API **ya devuelve** en cada comprobante y que normalmente no
se miran hasta que rompen:

- **Rechazos DGI** (`estado`): un CFE "Rechazado DGI" no tiene validez fiscal —
  la venta figura en el sistema y no existe ante DGI. Severidad `critica`.
  "Pendiente DGI" y similares salen como `advertencia`.
- **CAE por agotarse o vencer** (`cae.fin`, `cae.fecha_expiracion`): cuando se
  agota el rango autorizado o expira el CAE, la facturación se corta. Avisa con
  ≤500 números o ≤45 días (advertencia) y ≤100 números o ≤15 días (crítico).

```jsonc
{ "periodo": "ultimos_30_dias", "severidad_minima": "advertencia" }
```

> Los números de CAE disponibles son una **estimación optimista**: solo se ven
> los comprobantes del período consultado, así que el último número usado puede
> ser mayor al observado. Períodos más amplios dan una estimación más ajustada.

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
  "endpoint": "/v3/comprobantes/emitir",
  "environment": "test",
  "write_enabled": false,
  "gate": { "allowed": false, "reason": "write_disabled", "requires_allow_production": false },
  "payload_preview": { "tipo_comprobante": 101, "sucursal": 6, "items": [ /* ... */ ] },
  "totales_estimados": { "subtotal": 200, "iva_por_tasa": { "22": 44 }, "total": 244, "exacto": true },
  "resumen": "Total estimado: UYU 244 (neto 200 — IVA 22%: 44)",
  "confirmation_token": "v2.1788364800000.ZXhhbXBsZS1obWFj…",
  "next_step": "Para EJECUTAR, volvé a llamar … con confirm=true y el mismo confirmation_token",
  "no_network_call": true,
  "warnings": []
}
```

El preview **calcula el total localmente** (`totales_estimados` + la línea
`resumen`) para que confirmar no sea a ciegas. Es una estimación: el total
autoritativo es el que devuelve Biller. Si algún ítem usa una tasa que no se
puede determinar, `exacto` baja a `false` y se explica en `advertencias`.

Los documentos y contactos del receptor se **enmascaran parcialmente**
(`2149874400**`) en vez de ocultarse: hace falta reconocer a quién se le factura
para poder confirmar.

**2. Ejecución (`confirm: true` + `confirmation_token`)** — recién acá puede hacer el
`POST`, y solo si pasan **todas** las barreras:

1. **Aprobación autenticada**: el `confirmation_token` v2 está firmado por el servidor y
   queda atado al payload normalizado, endpoint, ambiente, tenant, empresa y conversación.
   Si cambia cualquiera de ellos —o se altera el timestamp— deja de valer. Vence a los
   15 minutos. Los tokens del formato anterior no se aceptan: hay que repetir el dry-run.
2. **Gate de escritura**: `BILLER_WRITE_ENABLED=true`.
3. **Gate de producción**: si el ambiente es `production`, además
   `BILLER_ALLOW_PRODUCTION_WRITES=true` **y** el argumento `allow_production=true`.
4. **Idempotencia**: una misma `idempotency_key` no se ejecuta dos veces en la sesión
   (también se envía como header `Idempotency-Key`). Además, si el comprobante trae
   `numero_interno`, antes de emitir se consulta a Biller si ese número ya se usó y
   se **aborta la emisión** si existe — es la única defensa que sobrevive a un
   reinicio del servidor (desactivable con `verificar_duplicado=false`).
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
El ejemplo usa una versión revisada del paquete publicado
(`npx -y biller-mcp-server@0.1.1`), por lo que no
depende de clonar este repositorio ni de mantener una ruta local a `dist/`.

## Configuración (`.env`)

Copiá `.env.example` a `.env`. **Empezá siempre por TEST.** El `.env` está en
`.gitignore`; no commitees tokens.

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `BILLER_API_BASE_URL` | Sí | — | `https://test.biller.uy` o `https://biller.uy`. |
| `BILLER_API_TOKEN` | Sí | — | Bearer token de la empresa. Nunca se loguea ni se devuelve. |
| `BILLER_CAPABILITY_MODE` | No | `read_only` | `read_only` (solo lectura) \| `write_enabled` (+ tools de escritura). |
| `BILLER_APPROVAL_SECRET` | Si hay escritura o Kapso | — | Clave exclusiva por tenant (mínimo 32 caracteres) para firmar approvals. Generá una con `openssl rand -hex 32`; no reutilices el token de Biller, la clave de Kapso ni secretos de otros tenants. |
| `BILLER_DEFAULT_EMPRESA_RUT` | No | — | Metadata local; **no** se envía a la API. |
| `BILLER_DEFAULT_SUCURSAL_ID` | No | — | Default de `sucursal` (lectura y emisión). **ID real** de Biller (Ajustes → Sucursales), no un valor genérico. Opcional: `obtener` no lo exige. |
| `BILLER_SUCURSALES_JSON` | No | — | Mapa `{"6":"Pocitos","7":"Centro"}` para nombrar sucursales en los reportes. Biller no expone un endpoint de sucursales. |
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

Para **habilitar escritura en test**: agregá `"BILLER_CAPABILITY_MODE": "write_enabled"`,
`"BILLER_WRITE_ENABLED": "true"` y una `"BILLER_APPROVAL_SECRET"` nueva de al menos
32 caracteres. Aun así, cada emisión/anulación requiere el flujo
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

Probá `biller_health_check` (mirá `capability_mode`/`write_tools_registered`/
`approval_secret_configurado`/`environment`).
Para probar escritura, pasá `BILLER_CAPABILITY_MODE=write_enabled` al inspector y verificá
que aparezcan las tools de escritura. Después llamá `biller_emitir_comprobante` en
**dry-run** y verificá el `confirmation_token`.

---

## Métricas: cómo sabemos que anda

Hasta acá había una suite de pruebas y **ninguna** métrica: no se sabía cuántos mensajes
caían en "no entendí" ni en qué paso se abandonaban las emisiones. La prueba de
que eso no alcanzaba es concreta — una prueba a mano encontró que **siete de
siete frases reales** caían en "no entendí", con la suite entera en verde.

`biller_metricas` contesta las tres preguntas que faltaban:

```
Mensajes: 10 | No entendidos: 20%

   2  via=saludo         opcion=ninguna
   2  via=desconocido    opcion=ninguna
   1  via=sinonimo       opcion=emitir
   1  via=aproximado     opcion=cobranzas
```

- **`enrutador.mensaje{via}`** — cuánto NO se entiende. Por encima del 20% la
  gente deja de escribir.
- **`emision.paso{paso}`** — el embudo. Si 100 llegan a "cliente" y 12 a
  "confirmar", se abandonan 88 emisiones y se ve en qué pregunta.
- **`resolver.consulta{clase}`** — cuántas veces hay que repreguntar.

**Acá no entra un dato fiscal, y la garantía es estructural.** Las métricas
salen por un canal (stderr, un agregador de logs, esta tool) que **no** pasa por
la barrera de salida ni por la de entrada: un dato que se filtre por acá no lo ve
ninguna de las dos. Por eso los nombres son una unión cerrada de TypeScript, los
valores se validan contra un patrón estrecho, y las corridas de 8+ dígitos —RUT,
CI, teléfono, número de comprobante— se rechazan aunque pasen ese patrón.

> Ese último filtro lo agregó un test que probó un RUT **y pasó**. "El filtro
> rechaza texto libre" no era lo mismo que "el filtro rechaza datos de un
> cliente"; se habían tratado como la misma cosa.

La instrumentación intercepta `registerTool`, igual que las barreras de entrada y
salida: toda tool futura queda medida sin que su autor se acuerde de nada.

En **serverless** los contadores casi no sirven (el proceso muere entre
invocaciones): ahí la fuente de verdad son las líneas `"msg":"metrica"` del log,
que se emiten igual. La respuesta lo dice en `alcance` en vez de dejar que se
asuma.

---

## El borrador de emisión ya no vive en el contexto del modelo

Emitir una factura por WhatsApp son diez o doce mensajes. Hasta acá el contrato
era **"el agente manda TODO lo que sabe en cada llamada"**, y el estado vivía en
el contexto del modelo — o sea que el flujo más caro del producto se apoyaba en
lo menos confiable que hay. Un agente que se olvida un campo hace que al usuario
le vuelvan a preguntar lo mismo; si se olvida el concepto del ítem, no hay forma
de notarlo y el CFE sale sin esa línea.

Pasándole `sesion` (el número de la conversación) a `biller_emision_guiada`, el
server guarda el borrador y lo usa como **base** sobre la que aplica lo que
llegue nuevo:

```jsonc
// mensaje 1
{ "sesion": "+598…", "clase_receptor": "empresa", "documento": "210000000011" }
// mensaje 2 — alcanza con el dato nuevo
{ "sesion": "+598…", "fecha_emision": "17/08/2026" }
```

Cuatro decisiones que vale la pena conocer:

- **La clave no es el teléfono, es un hash.** El número es un dato personal de un
  tercero y terminaría en el archivo y en cada log que mencione la clave.
- **`undefined` es "no me dijeron nada", nunca "borralo".** Si se confundieran,
  cada llamada incompleta vaciaría medio borrador — el problema que el store vino
  a resolver.
- **Un borrador vencido no se reanuda, se descarta** (24 h). Uno de hace tres
  días trae la fecha y los precios de hace tres días: reanudarlo en silencio es
  emitir un comprobante que el usuario cree que es de hoy.
- **El borrador es de quien lo está cargando.** Con Kapso configurado, `sesion`
  tiene que resolver al mismo usuario que la barrera de entrada ya verificó: un
  `sesion` ajeno se rechaza, no se abre. La empresa suele tener dos números
  autorizados —el dueño y el contador—, y sin esta regla *"seguí la factura que
  estaba armando el 099…"* alcanzaba para leerle el borrador al otro, agregarle
  líneas y emitir un CFE real con sus datos. Con `remitente` alcanza: el server
  ya sabe de quién es el borrador.
- **Usá el `sesion.id` que devuelve la tool, no el teléfono.** El mismo número
  escrito de dos formas —`099 123 456` y `+598 99 123 456`— son dos sesiones, y
  `config.ts` ya decidió que adivinarle el código de país a un número uruguayo es
  peor que avisar. El `id` es opaco y exacto: no se puede escribir de dos formas.
- **El borrador se descarta al emitir, no antes.** Pasale ese mismo `sesion.id` a
  `biller_emitir_comprobante` — si no hay borrador con esa clave, el dry-run te
  avisa, que es cuando todavía se puede corregir. Se borra solo con `mode: executed` y un `2xx`: un
  dry-run o un 422 lo conservan, porque ese es justo el momento en que más vale.

La persistencia a disco es **opt-in** (`BILLER_BORRADOR_STORE_PATH`), al revés
que la de idempotencia. Esa guarda solo una key; esta guardaría qué se vendió, a
quién y la adenda — información comercial de la empresa y datos de sus clientes.
En stdio y en el server HTTP largo la memoria alcanza de sobra.

---

## Seguridad y límites

- **Aislamiento de escritura fiscal**: todo `POST` del runtime hacia Biller vive
  en `src/write/`; `src/tools/write/` prepara y valida la operación.
  El guard estático (`npm run check:readonly` + `tests/readonly.test.ts`) falla si
  aparece escritura en cualquier otro lado: la superficie de lectura es GET-only.
  La única excepción que emite hacia Biller fuera del runtime es el probe destructivo de integración
  [`scripts/contrato-post.mjs`](scripts/contrato-post.mjs), que exige doble opt-in,
  credenciales y payload dedicados, permisos 0600 y el host exacto de TEST.
- **Escritura apagada por defecto** + dry-run + confirmación + doble gate de
  producción + idempotencia + audit log.
- **Credenciales protegidas**: el bearer token de Biller y `BILLER_APPROVAL_SECRET`
  nunca se loguean ni se devuelven; se redactan de los errores (`[REDACTED]`). El
  `confirmation_token` sí se entrega al usuario para completar el ciclo, pero es un
  HMAC de vida corta y no permite reconstruir la clave. El audit guarda un **hash**
  del payload, no el payload ni el token de aprobación.
- **Aislamiento entre empresas**: con varias empresas en un proceso, el overlay
  de un tenant **no hereda** lo sensible que no declara (las `KAPSO_*`, la
  allowlist de remitentes, los flags de escritura, la identidad fiscal): se borra
  del entorno base, porque borrar hace el error imposible y exigir que se declare
  solo lo hace detectable. Las rutas de persistencia y los topes de monto van al
  revés —borrarlas afloja—, así que si el proceso las define y un tenant no
  declara la suya, el server **no arranca**. Tampoco arranca con el mismo
  `BILLER_API_TOKEN` en dos tenants ni con dos apuntando al mismo archivo.
- **El borrador de emisión es de quien lo carga**: con el canal de WhatsApp
  abierto, la barrera inyecta el remitente ya verificado y un `sesion` que apunte
  a otro número se rechaza. Dentro de una misma empresa hay normalmente dos
  teléfonos autorizados, y sin esto uno podía leer, editar y emitir con el
  borrador del otro.
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
7. **Header `Idempotency-Key` server-side** → probado en TEST el 03/09/2026:
   Biller aceptó el primer `/v3/comprobantes/emitir` (201), pero rechazó el
   reintento idéntico con 422 por `numero_interno` repetido. El header no quedó
   confirmado; la defensa efectiva es el número interno único más el journal
   persistente del MCP.
8. **Esquema de request de `POST /v3/comprobantes/emitir`** → la doc trae la *Tabla
   de Valores* completa y 12 ejemplos, pero no un JSON Schema. El cuerpo se valida
   contra esa tabla (ver abajo) y los campos no documentados pasan sin tocarse.
   Los demás POST (recibos, pagos, clientes, productos, anular) **sí** declaran
   schema con `required`, y ese `required` se respeta literalmente.

## Validación del CFE

`src/biller/cfeSchema.ts` tipa la Tabla de Valores completa: los 22 tipos de CFE,
`forma_pago`, los 16 `indicador_facturacion`, `tipo_documento`, `modalidad_venta`,
`clausula_venta`, `via_transporte`, `tipo_traslado`, `indicador_agente_responsable`,
y los largos máximos de cada campo.

El criterio de estrictez es deliberado:

- **Error** solo donde la doc dice *"Obligatorio"* o *"Mutuamente excluyente"*:
  exportaciones sin `modalidad_venta`/`clausula_venta`/`via_transporte`/`ncm`,
  remitos sin `tipo_traslado`, `referencias` junto con `referencia_global`,
  `referencia_global` sin `razon_referencia`, retenciones en CFE que no las admiten,
  y fechas fuera de rango.
- **Warning** para todo lo demás (e-Factura sin receptor, nota de ajuste sin
  referencia, falta de `numero_interno`…): se informa en el preview y el humano decide.
- **Passthrough** para los campos que la doc no lista: nunca se descartan datos.

> **Ojo con las fechas: la API usa DOS formatos.** `fecha_emision` y
> `fecha_vencimiento` de un CFE van en **dd/mm/aaaa**; las fechas de recibos y los
> filtros de lectura van en **aaaa-mm-dd**; `fecha` de un pago acepta ambos. Cada
> schema valida el suyo y el mensaje de error aclara cuál corresponde.

## Roadmap

Lo que **ya no** está acá porque se hizo: transporte Streamable HTTP, canal de
WhatsApp (Kapso), multi-tenant, barreras de entrada y salida.

Lo que falta, en orden de lo que bloquea a lo que no (los dos primeros del
backlog histórico —observabilidad y estado persistente del borrador— ya están:
`biller_metricas` y el store de sesión):

1. **Un usuario real con las métricas prendidas.** Todo lo de abajo son
   hipótesis hasta que `enrutador.mensaje` y el embudo `emision.paso` tengan
   datos de producción.
2. **Templates de WhatsApp.** El push proactivo fuera de la ventana de 24 h los
   necesita, y el sandbox de Kapso no los tiene. Bloquea el cierre de mes
   proactivo (BRAINSTORM V5.5).
3. **Resolver el dialecto de schemas por evidencia.** Zod v4 no elimina por sí
   solo `transport/dialecto.ts`; mantener el canario de protocolo y retirar el
   parche únicamente cuando el SDK deje de emitir draft-07 y `$ref`.
4. **Contrato externo con datos dedicados.** El harness GET read-only ya captura
   evidencia saneada con `BILLER_CONTRATO_READONLY=1`; queda operar el probe POST
   de idempotencia con sus dobles opt-ins contra TEST.
5. Validar paginación / filtros nativos / endpoint GET de clientes cuando existan.

## Fuente

Documentación oficial de la API de Biller (OpenAPI 3.0), servidores
`https://test.biller.uy` y `https://biller.uy`.
