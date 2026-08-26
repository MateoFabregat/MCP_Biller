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

Más de mil tests, sin red, en pocos segundos. Si eso pasa, el proyecto está sano.

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
| Entender *"che, y los que me deben?"* | Qué opciones existen ([`kapso/menu.ts`](../src/kapso/menu.ts)) |
| Elegir qué tool llamar | Qué tipo de CFE corresponde ([`kapso/emision.ts`](../src/kapso/emision.ts)) |
| Redactar la respuesta | **Todos** los importes ([`CALCULOS.md`](CALCULOS.md)) |
| Llevar el hilo de la conversación | Qué paso sigue, y a quién se le factura |
| Copiar el texto libre del usuario | A qué número sale un mensaje (allowlist) |

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

⚠️ **La clave del cache incluye la credencial** (`BillerClient.cacheId`, un hash).
Un cliente sin identidad **no se cachea**. Eso no es paranoia: con multi-empresa,
una clave compartida le sirve a una empresa los comprobantes de otra, y los
números se ven perfectamente normales.

---

## 6. Recetas

### Agregar una tool de lectura

1. Escribí la lógica pura en `src/services/` — sin red, testeable sola.
2. Escribí la tool en `src/tools/`, con `inputShape` y `outputShape` de Zod.
3. Registrala en [`tools/register.ts`](../src/tools/register.ts): el `register*`
   en `registerAllTools` **y** el nombre en `READ_TOOL_NAMES`.
4. Preguntate: **¿alguna frase del usuario llega a esta tool?** Si no, agregala
   como intención oculta en `OPCIONES_MENU` ([`kapso/menu.ts`](../src/kapso/menu.ts)).
   Hubo tres tools registradas y andando a las que ninguna frase podía llegar.
5. Actualizá el README (los conteos de `registry.test.ts` se derivan solos).

Las barreras ya te cubren: no hay que hacer nada para eso.

### Agregar una empresa

```bash
node scripts/onboard.mjs --tenant=<id>
```

Un tenant es un **overlay de variables de entorno** sobre las del proceso
([`tenants/registry.ts`](../src/tenants/registry.ts)). No hay un modelo de
configuración nuevo: lo que vale para una empresa vale para todas.

El `auth_token` es a la vez la credencial **y** el selector de empresa. No hay
header de tenant a propósito: con un token compartido, cualquiera cambiaría de
empresa cambiando un string.

### Tocar el enrutador de WhatsApp

Tres invariantes que ya costaron bugs silenciosos:

1. **Los prefijos propios (`menu:`, `emitir:`, `emision:`, `resolver:`) se
   resuelven ANTES que cualquier heurística.** Los botones que mandamos vuelven
   como texto, igual que "hola". `emitir:no` (✖️ Cancelar) contiene la cadena
   "emitir": sin esta regla, cancelar reabría el flujo recién cancelado.
2. **Un sinónimo de una sola palabra solo matchea como palabra completa**, y uno
   que se reduce a un solo token no puntúa por tokens. Sin la segunda, "me
   pagaron la factura 1234" matcheaba "mandar el PDF" al 100%.
3. **Ningún mensaje puede quedar sin respuesta.** Hay un test que recorre
   mensajes arbitrarios y exige que siempre haya opción, menú o respuesta.

Antes de escribir tests, corré el corpus. Mirá los `desconocido` tanto como los
ruteos mal.

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
  en disco. Los borradores vencen a las 24 h y se descartan al emitir.
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
├── security/        Las dos barreras: entrada (quién) y salida (qué)
├── services/        Lógica pura: agregación, reglas, resolvedor, parser de plata
├── tools/           Las 27 tools de lectura + write/ (7 de escritura)
├── kapso/           WhatsApp: menú, enrutador, emisión guiada, cliente
├── tenants/         Multi-empresa: registro, acceso, contextos
├── transport/       stdio, HTTP, serverless
├── write/           TODO lo que hace POST vive acá. Nada más.
└── server.ts        La fábrica. Las barreras van ANTES de registerAllTools.
```

Si vas a tocar un archivo, **leé su encabezado**. Casi todos explican por qué
existen y qué error concreto evitan. Ese comentario suele valer más que el
código.
