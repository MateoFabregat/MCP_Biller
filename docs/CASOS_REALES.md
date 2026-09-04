# Los casos reales — quién factura por WhatsApp y qué le pasa

> Análisis del flujo completo desde el lado del que lo usa, no del que lo
> escribe. Diez negocios uruguayos distintos, qué pide cada uno, qué contesta el
> server hoy, y dónde se rompe.
>
> Escrito el 04/09/2026, antes de conectar el Agent Node de Kapso.
>
> Los otros documentos contestan otra cosa: [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md)
> dice qué conversación ocurre mensaje por mensaje, [`KAPSO.md`](KAPSO.md) cómo
> se conecta el canal, y [`CALCULOS.md`](CALCULOS.md) de dónde sale cada número.
> **Este contesta: ¿está contemplado el caso de esta persona?**

---

## 1. Lo primero: qué se puede traer de la API y qué no

Es la pregunta que ordena todo el diseño, porque define qué se puede ofrecer
como botón. La API de Biller que conocemos tiene **quince endpoints**, y entre
ellos hay dos ausencias que deciden el producto:

| Lo que uno querría | ¿Existe? | Lo que hay en su lugar |
|---|---|---|
| Listar **mis clientes** | ❌ No hay GET de clientes | Se derivan del historial: a quién le facturaste y cuánto (`biller_ranking_clientes`). Y un RUT se confirma contra DGI (`nombre-entidad`). |
| Listar **mis productos** | ❌ No hay GET de productos | Se derivan del historial: qué conceptos facturaste más (`biller_ranking_productos`). |
| Ver comprobantes emitidos | ✅ `v2/comprobantes/obtener` | — |
| Ver comprobantes recibidos | ✅ `v2/comprobantes/recibidos/obtener` | — |
| PDF de un comprobante | ✅ `v2/comprobantes/pdf` | — |
| Datos de un RUT | ✅ `v2/dgi/empresas/*` | Nombre, datos de la entidad, certificado, actividad. |
| Emitir / anular | ✅ `v3/comprobantes/emitir`, `v2/comprobantes/anular` | — |
| Alta de cliente / producto | ✅ `v2/clientes/crear`, `v2/productos/cargar` | Se pueden CREAR, no leer. |
| Recibos y pagos | ✅ `crear`, `cancelar`, `pagos/crear` | — |

**La consecuencia práctica, y es buena:** el catálogo de clientes y de productos
de este asistente **es el historial de facturación**. No hay que mantener nada
aparte, no se desincroniza nunca, y ordena por lo que de verdad se vende. Un
kiosco que factura agua, cigarrillos y fiambre ve esas tres primero porque son
las tres que más facturó, sin que nadie las haya cargado.

Lo que sí falta hacer con eso está en §4.

---

## 2. Inventario de botones: cada uno, qué hace y qué trae

Los ids son un contrato (`kapso/protocolo.ts`): salen en el mensaje, el usuario
los toca, y vuelven como texto por el mismo canal que "hola".

### 2.1. El menú — `menu:` (una lista de WhatsApp, 10 filas máximo)

Diez visibles y diecisiete que existen sin ocupar fila: se llega a ellas
escribiendo, y el enrutador las reconoce por sinónimos.

| Fila | Id | Qué trae |
|---|---|---|
| Emitir un comprobante | `menu:emitir` | Arranca la emisión guiada. |
| Lo de siempre | `menu:repetir` | Copia la última venta aceptada de un cliente: ítems, precios, IVA y forma de pago. Va **derecho al preview**. |
| Ver un comprobante | `menu:ver_comprobantes` | Últimos emitidos, o uno por número. |
| ¿Quién me debe? | `menu:cobranzas` | Cuenta corriente: saldo por cliente, con antigüedad. |
| Registrar un cobro | `menu:cobro` | Recibo contra uno o varios comprobantes. |
| Resumen del día | `menu:dia` | Lo facturado hoy, con alertas. |
| ¿Cómo viene el mes? | `menu:mes` | Comparación contra el mes anterior. |
| Mandar un comprobante | `menu:enviar_pdf` | PDF por WhatsApp. |
| Anular un comprobante | `menu:anular` | Plan de anulación (dos pasos). |
| ¿Qué más podés hacer? | `menu:ayuda` | Las diecisiete ocultas. |

**Las ocultas** (se escriben, no se tocan): `riesgo`, `clientes`, `alertas`,
`recibidos`, `cancelar_recibo`, `recordar_cobro`, `productos`, `iva`,
`sucursales`, `metricas`, `cohortes`, `proveedores`, `alta_cliente`,
`alta_producto`, `pago_proveedor`, `datos_rut`.

### 2.2. La emisión — `emision:` (botones dentro del flujo)

| Botón | Id | Qué queda decidido |
|---|---|---|
| 🏢 A una empresa | `emision:receptor:empresa` | **e-Factura (111)**, receptor obligatorio. |
| 👤 Consumidor final | `emision:receptor:final` | **e-Ticket (101)**, receptor opcional bajo 5.000 UI. |
| 🤔 No sé | `emision:receptor:no_se` | Repregunta con dos opciones más concretas. |
| (fila de cliente) | `emision:cliente:<documento>` | Fija el RUT/CI. Solo aparecen clientes CON documento. |
| ➕ Otro cliente | `emision:cliente:otro` | Pide el documento a mano. |
| 👤 Sin identificar | `emision:cliente:sin_identificar` | e-Ticket sin receptor. |
| 🇺🇾 Pesos / 💵 Dólares | `emision:moneda:UYU` / `:USD` | Moneda. En USD se pide cotización. |
| ✅ Ya incluye IVA | `emision:iva_incluido:si` | `montos_brutos=true` + tasa básica. **El precio ES el total.** |
| ➕ Se suma aparte | `emision:iva_incluido:no` | `montos_brutos=false`: al precio se le SUMA 22%. |
| 🔢 Otro IVA | `emision:iva_incluido:otro` | Abre la pregunta de tasa. |
| IVA 22% / 10% / Exento | `emision:iva:3` / `:2` / `:1` | Indicador de facturación. |
| ➕ Otro ítem | `emision:item:otro` | Abre una línea más. |
| ↩️ Volver así | `emision:item:cancelar` | Descarta la línea abierta **solo si no tiene nada**. |
| 🗑️ Sacar $X | `emision:item:descartar:<pos>:<precio>` | Descarta ESA línea, nombrando el monto. |
| ✅ Dejarlo así / 🗑️ Sacar línea | `emision:item:conservar_precio:…` / `descartar_precio:…` | Para una línea de precio cero o negativo. |
| 📅 Hoy / ✏️ Otra fecha | `emision:fecha:hoy` / `:otra` | Fecha de emisión. |

### 2.3. Confirmar, anular, resolver

| Botón | Id | Qué hace |
|---|---|---|
| ✅ Emitir | `emitir:si:<token>` | Emite. El token ata el payload exacto del preview. |
| ✖️ Cancelar | `emitir:no` | **Descarta el borrador.** No queda esperando. |
| 👀 Revisar | `anular:revisar:<token>` | Paso 1 de 2 de una anulación. |
| ✅ Anular / ✖️ No | `anular:si:<token>` / `anular:no` | Paso 2 de 2. |
| (candidatos) | `resolver:<n>` | Desambiguar un nombre de cliente o producto. |

---

## 3. Diez negocios reales

Cada uno con lo que de verdad escribe, lo que pasa hoy, y qué falta.

### 3.1. Contadora que factura honorarios mensuales
> *"Facturale a Estudio Gómez los honorarios de agosto, 18.000 más IVA"*

**Hoy funciona.** e-Factura 111, un ítem, `montos_brutos=false` (se suma el
22%), preview, emitir. Y el mes siguiente: **"lo de siempre a Gómez"** copia
todo y va derecho al preview — tres toques.
**Falta:** nada crítico. El caso está bien cubierto.

### 3.2. Kiosco
> *"2 aguas y un cigarrillo, 340"*

**Hoy funciona a medias.** e-Ticket sin receptor, precio con IVA incluido
(el precio de mostrador SIEMPRE lo lleva adentro). Pero el kiosquero factura
**decenas de ventas por día** y cada una son cuatro o cinco mensajes.
**Falta:** el atajo de §4.1 (productos frecuentes como botones) y el default de
"consumidor final sin identificar" para un negocio marcado como mostrador.

### 3.3. Ferretería que vende a empresas y a mostrador
> *"Ponele a la constructora 20 bolsas de portland a 610 c/u, a 30 días"*

**Hoy funciona.** Empresa → 111, cantidad y precio del texto, forma de pago
crédito → pregunta el vencimiento, y **"30 días" ahora se lee**.
**Falta:** que la lista de clientes frecuentes aparezca sola (§4.1).

### 3.4. Fletero
> *"Flete a Montevideo, 4.500, a Transportes del Este"*

**Hoy funciona.** Un ítem de servicio, e-Factura.
**Ojo:** si el cliente le paga en dólares, la cotización se pregunta y **no se
adivina** — correcto, pero es un mensaje más. El perfil de la casa ya recuerda
la moneda de las últimas facturas.

### 3.5. Peluquería
> *"corte y barba 900"*

**Hoy funciona.** e-Ticket, IVA incluido.
**Falta:** lo mismo que el kiosco: repetición rápida.

### 3.6. Panadería con reparto a comercios
> *"a la rotisería 30 panes a 25 y 10 facturas a 40"*

**Hoy funciona**, incluidas las dos líneas en un mensaje.
**Falta:** el reparto factura a los MISMOS diez comercios todos los días. La
lista de clientes frecuentes es exactamente su pantalla de inicio, y hoy
depende de que el agente se acuerde de pedirla (§4.1).

### 3.7. Consultorio — servicios de salud EXENTOS
> *"consulta 2.500, exento"*

**Hoy funciona, y mejor de lo que parece.** La primera vez hay que tocar 🔢 Otro
IVA y después Exento. Pero el **perfil de la casa** (`buscarPerfilCasa`) lee el
historial por su cuenta —el server, no el agente— y si todas las facturas
anteriores son exentas, deriva el indicador y **deja de preguntar**. Lo mismo
con la moneda, la forma de pago y si el precio lleva IVA adentro.
**El límite real:** el perfil solo deriva cuando TODAS las muestras coinciden.
Un negocio mixto —una óptica que vende armazones al 22% y hace consultas
exentas— nunca va a tener perfil, y contesta el IVA en cada factura. Ahí el
atajo tiene que ser por producto (§4.1), no por empresa.

### 3.8. Freelance que le factura al exterior
> *"facturale a mi cliente de España 1.200 dólares"*

**HOY NO ESTÁ CONTEMPLADO.** El flujo guiado solo produce **101 y 111**
(`tipoComprobantesugerido`). Una exportación de servicios es **e-Factura de
exportación (121)** con indicador 10, y además necesita `modalidad_venta`,
`clausula_venta` y `via_transporte`. El flujo lo llevaría a un 111 con IVA
22% a un cliente sin RUT uruguayo: **un comprobante mal emitido**.
**Falta:** o se soporta (§4.4) o se detecta y se deriva con todas las letras.

### 3.9. Almacén que quiere saber cuánto le deben
> *"¿quién me debe?"* · *"¿cuánto me debe Pérez al 30/09?"*

**Hoy funciona**, y la segunda pregunta se arregló en esta misma ola: filtrar
por cliente devolvía los totales de la cartera entera.
**Falta:** "al 30/09" — una fecha de corte en la cuenta corriente (§4.3).

### 3.10. Negocio con dos locales
> *"¿cómo va cada local?"* · *"facturá esto desde el local del centro"*

**Hoy funciona a medias.** Hay `biller_ranking_sucursales` para la consulta, y
la emisión usa `BILLER_DEFAULT_SUCURSAL_ID`. Pero **no hay forma de elegir
sucursal desde el chat**: si factura desde el otro local, sale con la del
default.
**Falta:** §4.5.

---

## 4. Los huecos, ordenados por lo que cuestan

### 4.1. Los frecuentes no aparecen solos — ALTA, y es la que más se nota
`clientes_frecuentes` existe y arma una lista tocable, pero **el server no la
llena**: solo aparece si el agente llamó antes a `biller_ranking_clientes` y
pasó el resultado. Si se olvida —y se olvida—, el usuario tipea doce dígitos de
RUT. Y para productos **no existe el equivalente**, aunque el dato está
(`biller_ranking_productos` los deriva del historial).

Lo que hace que esto sea barato de arreglar: **el server ya lee el historial
por su cuenta** para derivar el perfil de la casa (`buscarPerfilCasa`, una vez
por sesión y cacheado en el borrador). Los clientes y los productos frecuentes
salen de esa misma ventana, ya traída. No es una consulta nueva: es usar la que
ya se hizo.

**Qué hacer:** que la emisión guiada, en el paso `cliente` y en el paso
`concepto`, ofrezca los frecuentes **por su cuenta**, sacándolos del historial
que ya sabe leer. Es un toque en vez de doce dígitos, y convierte al kiosco y a
la panadería en casos de tres toques.

### 4.2. El negocio MIXTO contesta el IVA en cada factura — MEDIA
El perfil de la casa ya resuelve al negocio uniforme: deriva indicador, moneda,
forma de pago y `montos_brutos` del historial, solo, y deja de preguntar. Lo
que no cubre es el mixto (armazones al 22% y consultas exentas): como las
muestras no coinciden, no deriva nada y se pregunta siempre. La salida no es
otro default de empresa —sería adivinar la mitad de las veces— sino que el IVA
viaje con el PRODUCTO frecuente de §4.1: "consulta" ya sabe que es exenta
porque las últimas veinte veces salió exenta.

### 4.3. La cuenta corriente no tiene fecha de corte — MEDIA
*"¿cuánto me debían al 30 de junio?"* es la pregunta de todo cierre de mes.

### 4.4. Exportación: no contemplada — MEDIA, pero cara cuando pasa
Ver §3.8. Lo mínimo honesto: **detectar** que el receptor no es uruguayo y
decir "esto es una exportación, hay que emitirla distinto", en vez de emitir un
111 con IVA.

### 4.5. No se puede elegir sucursal desde el chat — MEDIA

### 4.6. Cosas que están bien y conviene NO tocar
- El preview con los tres botones y el token que ata el payload.
- La doble confirmación de la anulación.
- Que el IVA se pregunte con la plata adelante ("los $490 que me pasaste").
- Que cancelar descarte de verdad.

---

## 5. La propuesta: menos, no más

El pedido es "que sea bien sencillo". El menú tiene **27 intenciones**, diez
visibles. Para facturar por WhatsApp, la mitad sobra: `cohortes`, `metricas`,
`proveedores`, `sucursales`, `riesgo` y `recibidos` son preguntas de escritorio,
no de mostrador — y ya están ocultas, que es lo correcto.

**Las seis que un negocio usa todos los días:**

1. Emitir un comprobante
2. Lo de siempre
3. ¿Quién me debe?
4. Registrar un cobro
5. Resumen del día
6. Mandar un comprobante

Anular y "¿cómo viene el mes?" completan las ocho. Las otras diecinueve siguen
existiendo escritas, que es gratis.

**El camino corto que hay que lograr** — kiosco, tres toques:

```
"2 aguas 340"  →  [👤 Sin identificar]  →  [✅ Ya incluye IVA]  →  [✅ Emitir]
```

Y con los frecuentes de §4.1, la panadería:

```
[Lo de siempre]  →  [Rotisería El Sol]  →  [✅ Emitir]
```

---

## 6. Cómo se prueba, paso a paso

1. **Antes de tocar Kapso**, el flujo entero se puede recorrer sin WhatsApp:
   ```bash
   npm run diagnostico          # las seis capas por separado
   npm run conversar -- --guion # conversaciones reales contra el agente
   npm run evals                # el corpus del enrutador
   ```
2. **URL pública** (Kapso rechaza localhost): `ngrok http 8848`.
3. **Crear el flow**: `node scripts/kapso-flow.mjs https://<host>/mcp`.
4. **El ensayo integral**, en este orden: "hola" → menú → "2 aguas 340" →
   preview → ✅ Emitir → "mandámelo" → PDF → `biller_health_check` para ver el
   audit. Todo contra `test.biller.uy`.
5. **Los casos de esta página**: cada persona de §3 es un guion de prueba. Los
   que hoy fallan (§3.8) tienen que fallar **diciendo por qué**, no emitiendo.
