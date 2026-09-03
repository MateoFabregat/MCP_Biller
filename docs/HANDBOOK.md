# Handbook — para el dev que recién llega

> Leé esto antes de tocar código. En 20 minutos vas a poder cambiar cosas sin
> romper nada importante, y —más difícil— vas a entender **por qué** varias
> decisiones que parecen raras están así a propósito.
>
> Los otros documentos contestan preguntas distintas:
>
> | Documento | Contesta |
> |---|---|
> | [`ARQUITECTURA.md`](ARQUITECTURA.md) | Qué hay y cómo se conecta (diagramas). |
> | [`CALCULOS.md`](CALCULOS.md) | De dónde sale cada número, fórmula por fórmula. |
> | [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md) | Qué conversación ocurre, mensaje por mensaje. |
> | [`KAPSO.md`](KAPSO.md) | Cómo se conecta el server a WhatsApp. |
> | [`BRAINSTORM_V3.md`](BRAINSTORM_V3.md) | Qué se puede construir y en qué orden. |
> | [`EQUIPO.md`](EQUIPO.md) | Cómo se profesionaliza, opera y crece: diagrama completo, deploy, adaptación por empresa, el equipo de agentes. |
> | **Este** | **Cómo trabajar en el proyecto sin romperlo.** |

---

## 1. Qué es esto, en una frase

Un servidor MCP que le deja a un modelo de lenguaje contestar preguntas sobre la
facturación electrónica de una PyME uruguaya —y emitir comprobantes— **sin que el
modelo calcule ni un solo número**.

Esa última parte es la tesis del proyecto. Todo lo demás se deriva de ahí.

---

## 2. Los primeros 20 minutos

```bash
npm install && npm test
```

La suite automatizada corre sin red y termina en pocos segundos. Si eso pasa, el
proyecto está sano.

```bash
cp .env.example .env    # completá BILLER_API_BASE_URL y BILLER_API_TOKEN de TEST
node scripts/onboard.mjs
```

`onboard.mjs` verifica la configuración **contra la API real** y te dice qué
falta. Solo hace GET: no emite nada, se puede correr sin miedo.

Después, los tres comandos que vas a usar todo el tiempo:

```bash
npm run typecheck && npm test && npm run check:readonly
```

Y cuando lo que falla es **el WhatsApp** —el usuario escribe y no le contesta
nadie— hay dos comandos más, porque ese síntoma no deja rastro en ningún lado:

```bash
npm run diagnostico    # las seis capas por separado; la primera que falla explica el resto
npm run conversar -- --guion   # conversaciones reales contra el agente de Kapso
npm run contrato       # ¿la API de Biller sigue comportándose como creemos?
```

`diagnostico` recorre Kapso (workflow, trigger, conversaciones trabadas en
handoff), el transporte MCP **contra la URL que Kapso tiene guardada** —no
contra localhost—, el catálogo de tools, el enrutador entero (los 382 sinónimos)
y la ejecución real de cada tool de lectura. No emite, no anula y no manda
WhatsApps: lo que escribe se lista y se saltea.

`conversar` sí manda mensajes reales al número de la allowlist. Úsalo cuando
`diagnostico` da todo verde y querés ver qué hace el agente con una frase.

`contrato` es distinto de los tests y no los reemplaza. Los tests usan fixtures
y dicen que NUESTRO código hace lo que dice; `contrato` llama a la API real y
dice si la REALIDAD contra la que se escribió sigue siendo esa. Hay siete
comportamientos de Biller que se descubrieron llamándola de verdad y **cuatro
contradicen al OpenAPI**: si Biller cambia uno, la suite local puede seguir pasando y
lo que se rompe es un número en el teléfono de alguien, semanas después. Solo
hace GET.

El tercero es el menos obvio y el más importante: verifica **estáticamente** que
fuera de `src/write/` no exista ningún POST. Es lo que garantiza que agregar una
tool de lectura no pueda emitir un comprobante por accidente.

---

## 3. El modelo mental

Tres capas, y la regla es que **cada una sabe menos que la de abajo**:

```
  Conversación   ← el modelo entiende lenguaje y elige tools
  ─────────────────────────────────────────────────────────
  Decisión       ← TypeScript decide: qué CFE, qué paso, qué candidatos
  ─────────────────────────────────────────────────────────
  Datos          ← la API de Biller, normalizada y cacheada
```

**Dónde está el LLM y dónde no.** Es la pregunta que más se hace todo el que
llega:

| Lo hace el modelo | Lo hace TypeScript |
|---|---|
| Entender *"che, y los que me deben?"* | Qué opciones existen ([`kapso/intenciones.ts`](../src/kapso/intenciones.ts)) |
| Elegir qué tool llamar | Qué tipo de CFE corresponde ([`kapso/emision.ts`](../src/kapso/emision.ts)) |
| Redactar la respuesta | **Todos** los importes ([`CALCULOS.md`](CALCULOS.md)) |
| **Transportar** el texto del usuario, tal cual | Leer los números de ese texto ([`kapso/extraerPedido.ts`](../src/kapso/extraerPedido.ts)) |
| Llevar el hilo de la conversación | Qué paso sigue, y qué se acuerda entre mensajes ([`kapso/borradorStore.ts`](../src/kapso/borradorStore.ts)) |
| Preguntar cuando hay dudas | Cuándo hay dudas ([`services/resolver.ts`](../src/services/resolver.ts)) |
| Copiar el texto libre del usuario | A qué número sale un mensaje (allowlist) |

El renglón del medio es el más nuevo y el que más cuesta si se invierte: el
modelo **transporta** el mensaje, no lo interpreta. `Number("6.500")` es 6,5.

Si te encontrás escribiendo un prompt para que el modelo decida algo de la
columna derecha, parate: esa decisión va en código, se testea, y no cambia de
humor entre conversaciones.

---

## 4. Las cuatro barreras (y la quinta envoltura, que no es una barrera)

Ninguna es una convención. Las cuatro son estructurales: **no se pueden saltear
sin desarmarlas a propósito.**

### 4.1. Entrada — ¿quién pregunta?

[`security/entrada.ts`](../src/security/entrada.ts) intercepta `registerTool` y
le agrega `remitente` al input de **toda** tool, presente o futura. Un teléfono
que no está en la allowlist recibe una negativa antes de que el handler corra.

Se activa sola cuando hay Kapso configurado. Sin Kapso (stdio, Claude Desktop) no
molesta: ahí el que abre el server ya es dueño de la máquina.

⚠️ **La barrera no solo verifica: PISA.** Cuando la verificación produjo un
número, el `remitente` normalizado se escribe sobre el que mandó el modelo, en el
mismo campo. Antes se verificaba y se tiraba, así que cualquier tool que quisiera
atar algo a la identidad de quien escribe tenía que repetir
`normalizarTelefono` + `requiereRemitente` a mano — o sea, una convención, y una
convención se rompe con la tool número 25. Se pisa el mismo campo y no se agrega
un `__remitente_verificado`: con dos campos conviven "lo que dijo el modelo" y
"lo que verificó la barrera" bajo nombres parecidos, y la tool que lea el
equivocado falla en silencio y a favor del atacante. Con uno solo no hay forma de
confundirlos. En las tools exentas y sin Kapso el valor es `null` y el crudo se
deja intacto (`biller_health_check` lo necesita para decidir si degrada).

⚠️ **De quién es la conversación.** `sesion` lo elige el MODELO y acepta un
teléfono crudo. Dentro de una misma empresa hay normalmente dos números
autorizados (el dueño y el contador), así que *"seguí la factura que estaba
armando el 099123456"* alcanzaba para leer el borrador del otro, agregarle líneas
—`fusionarItems` fusiona por posición— y, en `biller_emitir_comprobante`, emitir
un CFE real con sus datos y de paso borrárselo. El cruce **entre** empresas ya lo
cerraba la sal del store; este era el intra-empresa, que la sal no puede ver
porque las dos partes son la misma empresa. Hoy la regla vive en
`identidadDeConversacion` ([`security/remitentes.ts`](../src/security/remitentes.ts)):
con canal abierto la identidad es el remitente verificado, y un `sesion` que
resuelve a otra clave se rechaza con `kind: "autorizacion"`. Vive ahí y no en
cada tool porque es **una** decisión, y una decisión copiada en tres archivos es
una que la cuarta tool no copia.

⚠️ **`biller_health_check` está exento, pero exento no es público.** Sigue siendo
lo único que se puede llamar sin autorización —una barrera que no se puede
diagnosticar se termina apagando entera—, pero ahora **degrada su salida**: sin
remitente verificado devuelve booleanos (`tiene_empresa_rut`,
`tiene_sucursal_default`, `tiene_audit_log`) en vez del RUT, la URL de la API y
la ruta del audit log. Tal como estaba, cualquiera que conociera el número de
WhatsApp confirmaba que la empresa existe, cuál es su RUT y si apuntaba a
producción, sin figurar en ninguna allowlist. Lo que se conserva es todo lo que
hace falta para diagnosticar: `status`, `missing`, `warnings`, modo de capacidad
y `environment`.

### 4.2. Salida — ¿qué se devuelve?

[`security/sanitize.ts`](../src/security/sanitize.ts) intercepta el mismo método
y pasa todo resultado por `sanitizeToolResult`: redacta secretos en profundidad y
envuelve los campos escritos por terceros en `⟦dato-no-confiable⟧`.

⚠️ **La envoltura es por NOMBRE DE CLAVE**, sin mirar de dónde vino el valor. Si
tu tool devuelve algo pensado para volver a entrar en un payload, **no puede
usar las claves `concepto`, `descripcion`, `razon_social`, `adenda`…** o las
marcas terminan impresas en un CFE. Ya pasó dos veces. Ver
[`security/untrusted.ts`](../src/security/untrusted.ts) para la lista completa.

### 4.3. Escritura — ¿se ejecuta?

Toda tool de escritura pasa por `runWriteOperation`
([`tools/write/shared.ts`](../src/tools/write/shared.ts)):

```
dry-run → confirmation_token (TTL 15 min, ligado al payload por hash)
        → confirm → gate de producción → tope de monto → idempotencia → POST → audit
```

### 4.4. Read-only estático — ¿puede haber un POST?

`scripts/check-readonly.mjs` falla el build si aparece un POST fuera de
`src/write/`. Las excepciones se declaran por línea con
`// check-readonly:allow <motivo>`, y hay un test que exige que el motivo esté
escrito.

### 4.5. Instrumentación — ¿cómo sabemos que anda?

[`observabilidad/instrumentar.ts`](../src/observabilidad/instrumentar.ts) usa el
mismo truco: intercepta `registerTool` y cuenta invocaciones, desenlaces y
duraciones de **toda** tool. No es una barrera de seguridad, pero comparte el
mecanismo por el mismo motivo — medir tool por tool es una convención, y una
convención se rompe con la tool número 40.

Va **primero** de las cuatro envolturas, para quedar más afuera que la barrera de
entrada: así un remitente rechazado también se cuenta.

⚠️ **Por acá no puede salir un dato fiscal.** Las métricas van a un canal que no
pasa por ninguna de las barreras. Los nombres son una unión cerrada, los valores
se validan contra un patrón estrecho, y las corridas de 8+ dígitos se rechazan.
Ver [`observabilidad/metricas.ts`](../src/observabilidad/metricas.ts).

La **línea de log** lleva además `empresa` (el id del tenant). No entra en los
contadores en memoria —esos ya son uno por empresa, ahí sería una etiqueta
constante que solo gasta cardinalidad—: hace falta en el log porque es la única
salida que se mezcla entre empresas, y sin eso, con veinte tenants, el agregador
no puede contestar de quién es el embudo de emisión que se cayó. El id pasa por
`normalizarValor` como cualquier otra etiqueta: la garantía de este módulo es
estructural, no "confiamos en el llamador".

**Las cuatro barreras —y la instrumentación— se desactivan igual: moviéndolas después de
`registerAllTools` en [`server.ts`](../src/server.ts).** No falla nada visible. Es
el error más caro que podés cometer en este repo.

---

### 4.6. Qué día es hoy — y por qué tiene su propio módulo

`services/fechaUy.ts` es la única respuesta válida a "¿qué día es?". **Nunca uses
`new Date().getDate()` ni `toISOString().slice(0,10)` para eso.**

El proyecto no fija `TZ` en ningún lado, así que en un contenedor el proceso
corre en **UTC** y Uruguay es UTC−3. Había dos funciones contestando esa pregunta
de dos formas distintas, y las dos estaban mal: un comercio facturando a las
21:30 de Montevideo recibía la fecha de **mañana** en un CFE real, y *"¿cuánto
vendí hoy?"* contestaba cero. Peor: podían estar en días distintos al mismo
tiempo, así que el comprobante se emitía con una fecha y el resumen lo buscaba en
otra.

---

## 5. Cómo se lee de la API (y por qué no es directo)

La API de Biller tiene tres características que definen todo el camino de
lectura:

1. **`desde`/`hasta` filtran por fecha de CREACIÓN, no de EMISIÓN.** Una venta
   del 30/06 cargada el 02/07 no aparece si preguntás por junio. Por eso se
   consulta con un margen de 5 días y se filtra localmente por emisión.
2. **No pagina: falla.** Un rango amplio devuelve 500. Por eso el período se
   parte en ventanas de 7 días.
3. **Los 500 no son excepcionales.** Están documentados. Por eso hay reintento.

De ahí sale [`services/periodo.ts`](../src/services/periodo.ts), y el costo que
tenía antes de julio de 2026: **5,5 segundos de red por cada tool** que consulte
90 días, y una conversación de tres preguntas los pagaba tres veces.

Hoy las ventanas se piden **en paralelo acotado** (4 a la vez), con **reintento**
de lo transitorio, y pasando por un **cache** con TTL doble:

| | Antes | Ahora |
|---|---|---|
| Primera pregunta (90 días) | 5,5 s | 3,2 s |
| Segunda pregunta, misma conversación | 5,5 s | **4 ms** |

El TTL es doble a propósito: una ventana pasada no puede ganar filas, pero su
campo `estado` sí cambia (Pendiente DGI → Aceptado DGI), y los totales se
calculan solo sobre "Aceptado DGI". 120 s para lo reciente, 30 min para lo que
ya se asentó. Ver [`biller/cacheVentanas.ts`](../src/biller/cacheVentanas.ts).

⚠️ **La grilla de ventanas es GLOBAL, no por período.** Antes cada período
generaba sus propias claves, así que `mes_actual`, `ultimos_30` y `ultimos_90`
—que se superponen casi enteros— tenían **cero aciertos entre sí**: la segunda
pregunta de una conversación volvía a pedir los mismos días. Con una grilla
común comparten claves, y el hit/miss se cuenta **por empresa**.

Todo eso entra por una sola puerta: [`services/ventana.ts`](../src/services/ventana.ts).
Si estás escribiendo `consultarPorPeriodo` + filtro por emisión + warnings a
mano, esa función ya lo hace, y hacerlo aparte es cómo se separan los números de
dos tools que deberían coincidir.

⚠️ **La clave del cache incluye la credencial** (`BillerClient.cacheId`, un hash).
Un cliente sin identidad **no se cachea**. Eso no es paranoia: con multi-empresa,
una clave compartida le sirve a una empresa los comprobantes de otra, y los
números se ven perfectamente normales.

⚠️ **Y el PRESUPUESTO también es por empresa.** Aislar los datos no alcanzaba:
mientras el techo fue uno solo para todo el proceso (500 entradas), las empresas
competían por él, y como una consulta de `anio_actual` son 53 ventanas, tres
empresas preguntando eso a la vez desalojaban las ventanas calientes de las otras
diecisiete. El modo de falla es el peor: no rompe ningún test, no salta ninguna
alerta, y la promesa medida de la tabla de arriba —4 ms— se degrada a segundos en
silencio. Hoy el cache es un mapa de mapas: **64 ventanas por empresa** (el
working set de la consulta más cara entra completo) y un techo de **16 empresas**
guardadas a la vez, con LRU de verdad —se reinserta **en el acceso**, así que lo
que se cae es lo que nadie mira, no lo más viejo de creación— y desalojando
siempre dentro del mapa de la empresa que acaba de escribir. El techo cuenta
entradas, no bytes: una empresa de mucho volumen pesa mucho más que otra con el
mismo número de ventanas, y ese es el próximo lugar a mirar si el proceso crece
de memoria.

---

## 6. Recetas

### Agregar una tool de lectura

1. Escribí la lógica pura en `src/services/` — sin red, testeable sola.
2. Escribí la tool en `src/tools/`, con `inputShape` y `outputShape` de Zod.
3. Registrala en [`tools/register.ts`](../src/tools/register.ts): el `register*`
   en `registerAllTools` **y** el nombre en `READ_TOOL_NAMES`.
4. Si necesita traer comprobantes de un período, usá
   [`services/ventana.ts`](../src/services/ventana.ts) en vez de repetir el
   preámbulo (período → sucursal → consulta → recorte → warnings). Ese preámbulo
   estaba copiado en quince tools.
5. Preguntate: **¿alguna frase del usuario llega a esta tool?** Si no, agregala
   como intención oculta en `OPCIONES_MENU`
   ([`kapso/intenciones.ts`](../src/kapso/intenciones.ts)). Hubo tres tools
   registradas y andando a las que ninguna frase podía llegar.
6. Actualizá el README (los conteos de `registry.test.ts` se derivan solos, y
   `tests/conteosDoc.test.ts` vigila que ningún doc afirme un conteo falso).

Las barreras ya te cubren: no hay que hacer nada para eso.

### Agregar una empresa

```bash
node scripts/onboard.mjs --tenant=<id>
```

El script pasa el `env` del tenant por el mismo `construirRegistro`/`entornoDe`
que usa el server, así que lo que te muestra es exactamente lo que el server va a
usar — y si la configuración es de las que no arrancan, te lo dice acá y no a las
siete de la tarde.

Un tenant es un **overlay de variables de entorno** sobre las del proceso
([`tenants/registry.ts`](../src/tenants/registry.ts)). No hay un modelo de
configuración nuevo: lo que vale para una empresa vale para todas.

El `auth_token` es a la vez la credencial **y** el selector de empresa. No hay
header de tenant a propósito: con un token compartido, cualquiera cambiaría de
empresa cambiando un string.

⚠️ **El overlay NO es herencia pura, y ese es el punto.** Lo que el tenant no
declara no lo hereda: lo sensible se **borra** del entorno base
(`VARIABLES_QUE_NO_SE_HEREDAN` — las cuatro `KAPSO_*`,
`BILLER_REMITENTES_AUTORIZADOS`, los tres flags de capacidad de escritura y la
identidad fiscal: RUT, sucursal, mapa de sucursales). Heredarlas mandaba los
mensajes de una empresa por la cuenta de WhatsApp de otra, dejaba la allowlist de
egreso apuntando a teléfonos ajenos, hacía valer la allowlist de consulta de A
para B y regalaba el permiso de emitir en producción que alguien había habilitado
para otra. Se borra en vez de exigir que se declare porque borrar hace el error
**imposible** en vez de detectable, y se puede borrar porque el default de todas
es el seguro: sin capability mode se queda en `read_only`, sin allowlist de Kapso
no sale ningún mensaje. Lo que sí se hereda es lo que describe al **despliegue** y
no al cliente: base URL, timeouts, puerto.

Y hay una tercera regla, para las variables donde borrar afloja en vez de
apretar: las tres rutas de persistencia (`BILLER_AUDIT_LOG_PATH`,
`BILLER_IDEMPOTENCY_LOG_PATH`, `BILLER_BORRADOR_STORE_PATH`) y los topes
`BILLER_MAX_MONTO_<MONEDA>` **ni se heredan ni se borran**: si el proceso las
define y un tenant no declara la suya, el server **no arranca**. Sin ruta de
audit no queda rastro fiscal; sin tope no hay nada entre una coma mal puesta y un
CFE por cien veces lo que valía.

Dos duplicados son fatales por la misma razón —parecen andar—: el mismo
`BILLER_API_TOKEN` en dos tenants (mismo `cacheId` ⇒ misma sal y mismo espacio de
borradores, con la idempotencia separada: un reintento por el otro token emite un
duplicado ante DGI) y el mismo archivo en cualquiera de las tres rutas,
comparadas en **absoluto** y de forma **cruzada** entre las tres variables.

### Tocar el enrutador de WhatsApp

Primero: **el enrutador ya no es un archivo.** Una intención nueva se agrega en
[`kapso/intenciones.ts`](../src/kapso/intenciones.ts) y **nada más**; el
matching vive en `enrutador.ts`, los mensajes en `render.ts` y los prefijos de
id en `protocolo.ts`. `menu.ts` es la fachada que re-exporta todo, así que
seguís importando de ahí.

Cinco invariantes que ya costaron bugs silenciosos:

1. **Los prefijos propios (`menu:`, `emitir:`, `emision:`, `resolver:`) se
   resuelven ANTES que cualquier heurística.** Los botones que mandamos vuelven
   como texto, igual que "hola". `emitir:no` (✖️ Cancelar) contiene la cadena
   "emitir": sin esta regla, cancelar reabría el flujo recién cancelado.
2. **Un sinónimo de una sola palabra solo matchea como palabra completa**, y uno
   que se reduce a un solo token no puntúa por tokens. Sin la segunda, "me
   pagaron la factura 1234" matcheaba "mandar el PDF" al 100%.
3. **La inclusión ordena por longitud**, así que un sinónimo corto le roba
   mensajes a una intención más específica. Cuando dos intenciones compiten, la
   defensa es una frase **más larga que contenga a la otra** ("me equivoqué con
   el recibo" vs. "me equivoqué"): así gana sin producir un empate.
4. **El extractor de pedidos va ÚLTIMO.** Cualquier coincidencia del catálogo le
   gana, y también la rama del flujo abierto. No compite con el enrutador: se
   queda con lo que iba a caer en "no entendí".
5. **Ningún mensaje puede quedar sin respuesta.** Hay un test que recorre
   mensajes arbitrarios y exige que siempre haya opción, menú o respuesta.

Antes de escribir tests, corré el corpus (`npm run evals`). Mirá los
`desconocido` tanto como los ruteos mal. Y si el cambio es un refactor que no
debería cambiar ninguna decisión, comparalo por **diferencial** contra HEAD
sobre el corpus entero: es lo que permitió partir `menu.ts` en cinco archivos
sabiendo que no se movió un solo ruteo.

### Tocar la emisión guiada

Cuatro reglas que sostienen todo lo demás:

1. **`siguientePaso` es pura.** Los dos datos del mundo que necesita —qué día es
   hoy y el perfil de la casa— entran por parámetro. Si le agregás una lectura
   del reloj o de la red, el test de los 64 estados parciales deja de significar
   algo.
2. **Los defaults se aplican en una COPIA, nunca en el borrador guardado.** En
   lo persistido, `forma_pago: undefined` significa "no me dijeron nada" y `1`
   significa "el usuario dijo contado". Si el default se escribiera ahí, los dos
   casos quedarían indistinguibles y una corrección posterior tendría que
   discutirle a un dato de su misma jerarquía.
3. **Todo default sale escrito en el preview.** Un default que el usuario no ve
   no es un default: es una suposición nuestra impresa en un documento fiscal.
4. **La jerarquía es una sola y no se invierte:** lo que dijo el usuario > lo
   leído de su texto > el perfil de la casa > el default duro.
5. **Ningún ítem incompleto en el medio llega a `confirmar`.** El concepto de
   cada línea se copia POR POSICIÓN (el agente desde `completar`, y
   `completarDesdeSesion` desde el borrador guardado), así que filtrar uno del
   medio le pone la descripción de una línea a otra en un CFE real. Por eso
   `siguientePaso` mira el primer ítem que no podría viajar —no el último— y
   `borradorComprobante` CORTA ahí en vez de saltearlo. Lo que se descarta al
   cerrar los ítems es un **sufijo**, y solo de ítems donde no se cargó **nada**
   (`itemSinNada`): sacar del final no mueve ninguna posición, pero una línea
   con precio y sin descripción se pregunta —nombrando el monto— y solo se
   descarta con un botón que dice cuánto saca. Descartarla sola facturaba $1.200
   en vez de $1.450 sin una palabra.
   Ojo con el criterio: "¿qué le falta preguntar?" (precio positivo) y "¿esta
   línea puede viajar?" (precio numérico, sin mirar el signo) son dos preguntas
   distintas — confundirlas trunca el borrador en una bonificación a $0 y
   factura de menos. Y si una línea negativa viaja, `calcularTotales` tiene que
   sumarle su IVA negativo: el neto se acumulaba sin guarda y el IVA detrás de
   `iva > 0`, así que el total del preview no era el del CFE.
6. **Lo que se lee del texto va al ítem EN CURSO.** Los ítems que devuelve
   `extraerPedido` están indexados por el MENSAJE, no por el comprobante:
   volcarlos desde 0 le pega la respuesta de ahora a la primera línea, y como
   solo llena huecos no falla por ningún lado. Ancla en
   `indiceItemEnCurso(itemsVigentes(estado))`, no se mezclan dos líneas con
   conceptos distintos —por subconjunto de tokens: "agua tónica" y "agua
   mineral" no son la misma— y sin ítem en curso no se vuelca nada. El `cliente`
   del texto solo vale mientras la etapa del cliente no haya quedado atrás, y la
   primera pregunta de ítem ya es "atrás".
7. **El server no parsea castellano libre para llenar un ítem.** Las preguntas
   de `concepto` y `precio` las contesta el agente mandando `items` explícito.
   Se intentó lo contrario y se revirtió: ver `TODO_NEXT.md` (P1) para los siete
   casos que rompieron, que son la especificación del día que se haga bien.

### Tocar los números

Leé [`CALCULOS.md`](CALCULOS.md) primero. Tres reglas que atraviesan todo:

- **Solo "Aceptado DGI" cuenta.** Los otros estados no tienen validez fiscal y
  no coinciden con lo que muestra Biller.
- **Las notas de crédito restan y los recibos NO son facturación**
  (`indicador_cobranza_propia = 1` es cobro de algo ya facturado: contarlo
  duplica).
- **No se convierte moneda.** Sumar UYU y USD da un número sin significado. Todo
  se acumula por moneda; la única excepción es `equivalente_uyu`, que usa la
  `tasa_cambio` **de cada comprobante** y es determinística.

---

## 7. Los errores que ya cometimos

Están acá para que no los repitas. Cada uno costó horas.

| Error | Qué pasó | La lección |
|---|---|---|
| Deducir límites de la lista de endpoints | "Biller no permite leer recibos" era falso: un recibo es un CFE con `indicador_cobranza_propia = 1`. Se enviaba un caveat falso en cada respuesta y los recibos se contaban como ventas. | En una API fiscal casi todo es un CFE. Buscá el dato **dentro** de los recursos que ya se leen, y leé las `description` de los endpoints. |
| Confiar en el OpenAPI | Cuatro de siete comportamientos verificados contra `test.biller.uy` **contradicen** la spec. La imputación de un recibo viaja en `items[].concepto`, no en `referencias`. | Probá contra el ambiente real **antes** de escribir los tests. |
| Devolver un borrador con `concepto` | La barrera de salida lo envolvió y las marcas iban a terminar impresas en el CFE. | Nada que vuelva a entrar puede usar una clave de `CAMPOS_NO_CONFIABLES`. |
| `Number("6.500")` | Es 6.5. En Uruguay son seis mil quinientos. El CFE queda bien formado y la factura dice seis pesos con cincuenta. | Los importes escritos por una persona los parsea [`services/importe.ts`](../src/services/importe.ts). Los que devuelve la API, `normalize.ts`. **Son dos convenciones opuestas y no se unifican.** |
| Comparar nombres con distancia de edición sobre la cadena entera | "Distribuidora Peres" resolvía a "Distribuidora **Sur** SA": trece letras de prefijo compartido le ganaban al Pérez correcto. | En nombres de varias palabras, el typo se perdona token a token. |
| Ordenar el menú por frecuencia de consulta | Facturar quedaba abajo. Es la única opción que tiene a alguien esperando del otro lado del mostrador. | El menú se ordena por **urgencia de la acción**, no por volumen. |
| Pedirle al modelo que se acuerde de un booleano | `en_flujo` había que mandarlo en cada llamada. Olvidarlo hacía que "pará, eran 3 no 2" cayera en `desconocido` y el webhook contestara el menú entero: la carga a medio hacer, a la basura. | Si el dato ya existe del lado del server (había o no un borrador vivo), **se deriva**. Un parámetro que el modelo tiene que recordar es un parámetro que a veces no llega. |
| Esconder la función más rápida del producto | "Lo de siempre" —dos mensajes hasta un CFE— estaba como intención oculta. Solo llegaba el que ya sabía la fórmula. | Una función que hay que adivinar no existe para el 90% de la gente. Lo oculto es para lo que se pregunta con palabras, no para lo que se usa todos los días. |
| Dejar la lógica compartida adentro de una tool | `biller_recordatorio_cobro` importaba la corrida de cuenta corriente desde `tools/cuentaCorriente.ts`. El número que ve el dueño y el que se le manda al cliente dependían de que nadie tocara la primera. | Lo que calcula vive en `services/`. Ninguna tool importa a otra. |

---

## 8. Lo que hoy NO se puede

Dicho en voz alta para que nadie lo prometa:

- **No hay costo de productos** en `productos/cargar` → no se pueden calcular
  márgenes sin un dato externo.
- **`items` solo viene consultando por `id`** → el ranking de productos es N+1
  acotado (40 comprobantes) y declara su cobertura.
- **No hay endpoint GET de clientes** → la cartera se **deriva** de la
  facturación. Un cliente que existe pero nunca compró no aparece.
- **La imputación de cobros es exacta *cuando el recibo la declara*, no siempre.**
  Corregido el 2026-07-29: la frase anterior decía "la cobranza no está
  verificada", y eso **dejó de ser cierto** el 28/07, cuando se verificó contra
  la API real que la imputación viaja en `items[].concepto`. Lo que sigue siendo
  cierto —y es lo que hay que leer— es más fino: el saldo **por cliente** es
  siempre exacto; **cuál factura** quedó impaga es exacto solo si el recibo lo
  declara, y estimado (FIFO) si no. La respuesta lo dice en `estrategia`, y
  `biller_recordatorio_cobro` lo usa para decidir si detalla facturas o solo el
  total. Un cobro hecho fuera de Biller sigue siendo invisible.
- **El estado de la emisión guiada ya no depende del contexto del modelo — si le
  pasás `sesion`.** Con ese parámetro el server guarda el borrador y lo usa como
  base en la llamada siguiente: el agente puede mandar solo el dato nuevo. Sin
  `sesion` sigue valiendo el contrato viejo ("mandá todo en cada llamada"), que
  es el que se rompe cuando el modelo se olvida un campo. El default del store es
  **memoria**, a propósito: el archivo (`BILLER_BORRADOR_STORE_PATH`) guarda el
  contenido del borrador —qué se vendió, a quién— y eso es información comercial
  en disco. Los borradores vencen a las 24 h y se descartan al emitir. Con el
  canal de WhatsApp abierto, **`sesion` ya no puede apuntar a otro**: el borrador
  es de quien lo está cargando, y el server contrasta contra el remitente que
  verificó la barrera (§4.1).
- **Una sesión HTTP no vive para siempre.** Vence a los 30 min sin uso
  (`BILLER_HTTP_SESSION_TTL_MS`) y hay techo de 200 simultáneas
  (`BILLER_HTTP_MAX_SESSIONS`), con LRU y **cerrando** el transporte al
  desalojar: sacarlo del mapa sin cerrarlo es la misma fuga con otra cara y
  encima invisible, porque el contador baja. Perder la sesión no pierde nada del
  negocio —el borrador vive aparte, con su propio TTL—: cuesta un `initialize`.
  El barrido es perezoso, al entrar cada request, para no dejar un `setInterval`
  que hay que acordarse de `unref()` y que trabaja aunque no haya tráfico.
- **En serverless la escritura se degrada a `read_only`**: la idempotencia es en
  memoria y un reintento duplicaría una factura ante DGI. Por el mismo motivo —un
  contexto nuevo por request— **el store de borradores en memoria no sirve ahí**:
  cada mensaje arrancaría de cero. Serverless necesita el archivo, y el
  filesystem es de solo lectura salvo `/tmp`, que tampoco se comparte entre
  instancias. Para el flujo de emisión por WhatsApp, hoy el transporte que
  corresponde es el HTTP largo.
- **Las métricas son POR PROCESO, no históricas.** `biller_metricas` cuenta
  desde que arrancó el proceso. Para una serie en el tiempo hay que juntar las
  líneas `"msg":"metrica"` del log en un agregador; en serverless esa es la
  única fuente que sirve. No hay dashboard todavía.

---

## 9. Mapa de archivos

```
src/
├── biller/          Cliente HTTP, schemas, normalizadores, cache de ventanas
│   ├── traerVentanas.ts   ventanas de 7 días en paralelo acotado, con reintento
│   ├── traerDetalles.ts   el detalle por id (el listado NO trae items), con cache
│   └── cacheVentanas.ts   TTL doble: 120 s lo reciente, 30 min lo asentado
├── security/        Las dos barreras: entrada (quién) y salida (qué)
├── services/        Lógica pura: agregación, reglas, resolvedor, parser de plata
│   ├── ventana.ts             LA COSTURA DE LECTURA: período → sucursal →
│   │                          consulta → recorte por emisión → warnings.
│   │                          La usan 15 tools; antes cada una la copiaba.
│   ├── calcularTotales.ts     los totales del CFE y el TEXTO del preview
│   │                          (ítems, desglose de IVA, TOTAL, supuestos)
│   ├── repetirUltima.ts       "lo de siempre" + derivarPerfilCasa
│   ├── corridaCuentaCorriente.ts  orquestadora declarada: hace red a propósito
│   ├── certificadoDgi.ts      el certificado viene PLANO, sin la envoltura
│   ├── periodo.ts             ventaneo, periodoAnterior, "hoy" uruguayo vía fechaUy
│   └── fechaUy.ts             la ÚNICA respuesta válida a "¿qué día es?" (§4.6)
├── tools/           Las 27 tools de lectura + write/ (7 de escritura).
│                    Ninguna importa a otra: lo compartido vive en services/.
├── kapso/           WhatsApp. Nueve archivos, dependencias en una dirección:
│   ├── menu.ts            fachada: re-exporta todo lo de abajo
│   ├── intenciones.ts     DATOS: opciones, ids, tools, ~400 sinónimos, léxicos
│   ├── enrutador.ts       MATCHING: normaliza, puntúa, decide el `via`
│   ├── render.ts          los mensajes de WhatsApp (menú, listas, preview)
│   ├── protocolo.ts       los prefijos de id propios; corren ANTES del matching
│   ├── extraerPedido.ts   "2 bolsas a 6.500" → campos, leído por TypeScript
│   ├── emision.ts         qué paso sigue, los submenús, aplicarDefaults
│   ├── borradorStore.ts   el estado de la emisión, del lado del server
│   ├── webhook.ts         entrada de Kapso: firma, allowlist, ruteo
│   └── client.ts          los DOS únicos POST fuera de write/ (allowlist)
├── tenants/         Multi-empresa: registro, acceso, contextos
├── transport/       stdio, HTTP, serverless
├── write/           TODO lo que hace POST vive acá. Nada más.
└── server.ts        La fábrica. Las barreras van ANTES de registerAllTools.
```

Si vas a tocar un archivo, **leé su encabezado**. Casi todos explican por qué
existen y qué error concreto evitan. Ese comentario suele valer más que el
código.
