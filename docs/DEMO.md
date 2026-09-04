# La demo, paso a paso

> Para mostrarle esto a alguien en diez minutos. Cada mensaje está **probado
> contra TEST el 04/09/2026** y al lado dice qué contesta de verdad — si algo no
> coincide, no es que la demo salió mal: algo cambió y conviene mirarlo.
>
> Hay dos formas de hacerla y conviene saber cuál se puede hoy:
>
> | Camino | ¿Anda hoy? |
> |---|---|
> | **A. Desde un chat** (Claude Desktop / este proyecto) | ✅ sí, ahora |
> | **B. Desde WhatsApp** (Kapso) | ⚠️ falta cargar crédito en Kapso |

---

## 0. Antes de empezar (dos minutos)

```bash
npm run build && npm run start:local
```

En otra terminal, el túnel —solo hace falta para el camino B:

```bash
ngrok http 8848
```

El dominio de ngrok de este proyecto es **fijo**
(`transnatural-infortunately-rodrigo.ngrok-free.dev`), así que **no hay que
reapuntar Kapso** cada vez: si el túnel está arriba, la URL que Kapso ya tiene
guardada funciona.

Chequeo de que está todo en pie:

```bash
curl -s http://127.0.0.1:8848/healthz     # {"status":"ok","transport":"http"}
curl -s http://127.0.0.1:8848/readyz      # {"status":"listo"}
npm run diagnostico                        # las seis capas, una por una
```

Y si preferís mostrar la historia sin escribir nada:

```bash
npm run demo                 # siete escenas, sin emitir
npm run demo -- --emitir     # además emite un e-Ticket real en TEST
```

---

## 1. Camino A — la demo desde un chat

Copiá y pegá estos mensajes, en este orden. **La primera vez decile tu número**
(la barrera de entrada existe justamente para que un borrador sea de quien lo
está cargando):

> Mi número es 59895923567. Usalo como `remitente` en todas las llamadas.

### Acto 1 — "¿esto qué es?"

| Pegá esto | Lo que tiene que aparecer |
|---|---|
| `hola` | El menú con diez opciones numeradas, empezando por *Emitir un comprobante*. |
| `¿cómo viene el mes?` | **$1.766,44 en 6 comprobantes** (septiembre 2026). |
| `¿quién me debe?` | Cuenta corriente. Hoy en TEST: **nadie con saldo pendiente**. |
| `resumen del día` | El digest: *Plata en riesgo* (Estudio OLA SRL facturó 100% menos), *Facturado mes actual* $1.766 en 6. |

**El punto que se muestra acá:** ninguno de esos números lo calculó el modelo.
Los calcula TypeScript y el modelo solo los lee. Es la tesis del proyecto.

### Acto 2 — facturar, que es lo que la gente vino a ver

**Cinco mensajes, uno por vez.** Está probado tal cual: no hace falta que el
modelo entienda nada raro, el flujo lo lleva de la mano.

| # | Pegá esto | Lo que contesta |
|---|---|---|
| 1 | `quiero facturar` | *"¿A quién le estás facturando: a una empresa con RUT o a un consumidor final?"* |
| 2 | `consumidor final` | *"Elegí el cliente de la lista, o mandame el RUT."* — y ahí aparecen **tus clientes**, sacados del historial. |
| 3 | `sin identificar` | *"¿Qué le vendiste? Decime solo qué es."* |
| 4 | `2 aguas a 170` | *"Los $170 que me pasaste, ¿ya tienen el IVA adentro?"* con tres botones. |
| 5 | `si` | **Ya tengo todo** → el preview, listo para emitir. |

**Dos cosas para señalar mientras pasa:**

- En el paso 2 la lista de clientes **la trajo el server solo**, del historial de
  facturación. No hay un maestro de clientes que alguien tenga que mantener.
- En el paso 4 la pregunta trae **la plata adelante** ("los $170 que me
  pasaste"). Es la pregunta que decide si la factura sale 22% distinta, y por eso
  no se adivina nunca.

Para emitir de verdad, seguí con `emitilo` — sale un e-Ticket real en TEST,
serie MT.

**El atajo del mostrador**, para el kiosco que vende lo mismo veinte veces por
día:

| Pegá esto | Lo que contesta |
|---|---|
| `lo de siempre` | Copia la última venta **sin receptor** —ítems, precios, forma de pago— y salta derecho a la última pregunta que falte. Del historial real de TEST cae en *"¿ya tienen el IVA adentro?"*: un mensaje en vez de cinco. |

### Acto 3 — los frenos, que es lo que lo hace confiable

| Pegá esto | Lo que contesta |
|---|---|
| `facturale a mi cliente de España 1200 dólares` | Un aviso ⛔: *"Esto parece una venta a un cliente DEL EXTERIOR…"*, explica que el receptor va con documento extranjero y su país, y que el IVA no es el 22% que el flujo asume. **Bloquea el paso a emitir**: el flujo nunca dice "ya tengo todo". |
| `pará` *(con una factura a medio cargar)* | *"Listo, dejé la factura sin hacer y no emití nada."* Y descarta el borrador: el próximo "quiero facturar" arranca de cero, no reaparece la que cancelaste. |
| `cosas para atender` | Alertas operativas: rechazos de DGI, numeración de CAE por agotarse, rachas sin facturar. En TEST hoy: **0 alertas**, con las dos series de CAE analizadas. |

**El remate:** pedile emitir dos veces el mismo comprobante. La idempotencia lo
frena — un CFE duplicado ante DGI se arregla emitiendo otro comprobante, así que
acá no se puede duplicar por accidente.

---

## 2. Camino B — la demo desde WhatsApp

**Falta una sola cosa: crédito en Kapso.** Verificado el 04/09/2026: las cuatro
últimas ejecuciones del workflow fallaron, y el motivo que registra Kapso es

```
Insufficient credits. Add credits at
https://app.kapso.ai/projects/a5e0160e-b79a-4915-b691-786dc3a0f873/billing
```

No son mensajes de WhatsApp: de esos hay **0 usados de 2.000 incluidos** en el
plan Free. Es el **crédito prepago de Kapso** que consume el agente, y se carga
desde $10 en esa misma página.

Todo lo demás ya está y se verificó:

| Capa | Estado |
|---|---|
| Workflow "Biller — asistente de facturación" | ✅ activo |
| Trigger `inbound_message` en el número | ✅ activo |
| MCP apuntado a la URL del túnel | ✅ y el túnel responde |
| Handshake MCP por el túnel | ✅ |
| Enrutador (388 frases y botones) | ✅ 388/388 |
| Conversaciones trabadas en handoff | ✅ ninguna |
| Transcripción de audio | 30 min incluidos en el plan Free, **0 usados** |

Con el crédito cargado, la demo por WhatsApp son **los mismos mensajes del
camino A**, escritos al número. Y ahí se puede mostrar lo que un chat no muestra:
los botones de verdad, el PDF adjunto y —si la transcripción anda— dictar la
venta en un audio en vez de escribirla.

### Qué mirar si algo no contesta

```bash
npm run diagnostico    # dice CUÁL de las seis capas falló, no "no anda"
```

---

## 3. Lo que NO conviene mostrar todavía

Decirlo antes es mejor que que aparezca solo:

- **Exportación:** el flujo la frena, no la emite. Falta definir qué
  `indicador_facturacion` lleva (ticket 03).
- **Audio:** hay 30 minutos incluidos, pero **nunca se probó uno de punta a
  punta** (ticket 02). Si lo vas a mostrar, probalo antes.
- **Dos locales:** la elección de sucursal funciona, pero pide
  `BILLER_SUCURSALES_JSON` con más de uno configurado.
- **Productos como botones:** no existe, y es a propósito (ADR-002: el listado
  de la API no trae los ítems, así que el catálogo sería un N+1).
- **El túnel:** si se cae, el número queda mudo sin error visible. Para una demo
  con alguien delante, verificá `/healthz` por la URL pública un minuto antes.
