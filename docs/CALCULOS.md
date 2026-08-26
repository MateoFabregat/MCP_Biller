# Cómo se calcula cada cosa

> **La pregunta que este documento contesta:** cuando el asistente dice "facturaste
> $106.340", ¿de dónde sale ese número? ¿Lo sumó una fórmula o lo estimó un modelo?
>
> **La respuesta corta: todos los números salen de fórmulas.** No hay una sola
> cifra en este servidor que produzca un modelo de lenguaje. La IA elige qué tool
> llamar y redacta la respuesta; los números los calcula TypeScript, de forma
> determinística y reproducible.
>
> Escrito el 2026-07-28. Los hallazgos marcados **[verificado]** salen de
> consultas reales contra `test.biller.uy`, no de la documentación.

---

## 0. Las tres categorías

Cada cifra de este servidor cae en una de tres:

| Categoría | Qué significa | Cuántas |
|---|---|---|
| 🟢 **Fórmula exacta** | Aritmética sobre campos que devuelve la API. Dos corridas dan el mismo número. Auditable línea por línea. | La enorme mayoría |
| 🟡 **Fórmula + criterio declarado** | Aritmética exacta, pero apoyada en un supuesto que la API no confirma (ej.: qué es "contado"). El supuesto viaja en la respuesta. | 5 |
| 🔴 **IA** | Un modelo produce el valor. | **Ninguna** |

La tercera columna es el punto. **No hay cálculos con IA.** El modelo:

1. entiende la pregunta ("¿cuánto vendí en junio?"),
2. elige la tool y sus parámetros,
3. lee el JSON que devuelve,
4. lo redacta en castellano.

Nada de eso toca los números. Si el modelo se equivoca, se equivoca eligiendo la
tool o interpretando el resultado — nunca calculando mal una suma.

**Corolario práctico:** cualquier cifra de este servidor se puede reproducir a
mano con la respuesta cruda de la API y una calculadora. Si un número no cierra,
el bug está en el código y se puede encontrar; no es "el modelo que alucinó".

---

## 1. Facturación del período — `biller_resumen_facturacion_periodo` 🟢

**Pregunta:** "¿cuánto facturé este mes?"

```
total_por_moneda[m] = Σ ( total_i × signo_i )   para todo comprobante i con moneda m
```

Con tres reglas que cambian el resultado:

| Regla | Por qué |
|---|---|
| `signo` sale del **tipo de comprobante** | Ventas +1, Notas de Crédito **−1**, Notas de Débito +1. Sin esto, un cliente al que le facturaste 100 y le hiciste 90 de NC "facturó" 100. |
| Solo cuentan los **"Aceptado DGI"** (`solo_aceptados`, default `true`) | Es el criterio con el que Biller muestra sus propios totales. Contar los rechazados da un número que no coincide con el panel. |
| Los **recibos NO son facturación** | Un recibo se emite como e-Ticket o e-Factura: por tipo es indistinguible de una venta. Lo distingue `indicador_cobranza_propia = 1`. Sumarlo duplicaría la venta. Va aparte, en `cobrado_por_moneda`. |

**Estados observados** en el campo `estado`: `Aceptado DGI`, `Rechazado DGI`,
`Sobre Rechazado DGI`, `Pendiente DGI`, `Envío no corresponde`. No existe
"Anulado" — anular genera una Nota de Crédito separada, que ya resta.

### 1.1. El total en pesos cuando hay varias monedas 🟢

**Pregunta:** "facturé $X y US$Y… ¿cuánto es en total?"

```
equivalente_uyu = Σ ( aporte_i × tasa_cambio_i )
```

`tasa_cambio` es un campo **de cada comprobante**: la cotización que quedó
declarada ante DGI el día que se emitió (la UI de Biller la muestra como
"Cotización: 38,397"). No es un dato de mercado que haya que ir a buscar, ni una
estimación: es aritmética sobre un campo de la respuesta.

- Una factura en USD de enero queda valuada a la cotización **de enero**. Para el
  total facturado eso es lo correcto — es el criterio contable — pero **no**
  responde "¿cuánto valen hoy mis dólares?".
- Si un comprobante en moneda extranjera viene **sin** cotización utilizable, ese
  monto queda **fuera** del equivalente y la respuesta lo declara
  (`completo: false`, `cobertura_pct`). Nunca se inventa una tasa: multiplicar por
  una cotización adivinada puede bajar un total sin que nadie lo note.
- `totales_por_moneda` sigue siendo el dato primario. El equivalente convive, no
  reemplaza.

### 1.2. Ver las facturas que forman el total 🟢

`incluir_comprobantes: true` devuelve la lista de los comprobantes que se
sumaron, cada uno con su `aporte` (con signo), su `tasa_cambio`, su `aporte_uyu`
y su `id` — con ese `id` se pide el detalle (`biller_obtener_comprobante`) o el
PDF (`biller_obtener_pdf`).

El detalle se arma **dentro del mismo recorrido** que suma. No es una segunda
consulta con otro criterio: son exactamente los comprobantes que produjeron ese
número. Un test verifica que la suma de los `aporte_uyu` del detalle da el
`equivalente_uyu` publicado.

---

## 2. Períodos: por qué se consulta más de lo que se pide 🟡

La API filtra `desde`/`hasta` por **fecha de creación** (cuándo se cargó en
Biller), no por **fecha de emisión** (la fecha fiscal). Preguntar "¿cuánto vendí
en junio?" y filtrar por creación deja afuera una venta del 30/06 cargada el
02/07.

```
1. rango de consulta = rango pedido ± MARGEN_CREACION_DIAS (5)
2. se parte en ventanas de 7 días   → la API no pagina y tira 500 con rangos amplios
3. se deduplica por id
4. se filtra localmente por fecha_emision
```

El criterio (`fecha_emision`) viaja en cada respuesta, y también cuántas ventanas
se consultaron. **[verificado]** Un comprobante real del ambiente de test tiene
`fecha_emision: 2026-05-26` y `fecha_creacion: 2026-07-24`: 59 días de diferencia.
Sin el margen y el filtro local, ese comprobante aparecería en el mes equivocado.

---

## 3. Cuenta corriente — "¿quién me debe plata?" 🟢🟡

**Dos niveles con precisión distinta, y la respuesta siempre dice cuál usó.**

### 3.1. Saldo por cliente — exacto 🟢

```
saldo = Σ ventas a crédito + Σ notas de débito − Σ notas de crédito − Σ recibos
```

Todo sale de la misma consulta, porque **un recibo es un CFE**: vuelve en el
mismo `GET /v2/comprobantes/obtener` marcado con `indicador_cobranza_propia = 1`.
No hacen falta llamadas extra ni endpoints que Biller no expone.

### 3.2. Saldo por factura — necesita imputar 🟢

Saber *qué* factura quedó impaga requiere saber a cuál se aplicó cada cobro. Tres
caminos, en orden:

| Estrategia | Cómo | Precisión |
|---|---|---|
| `referencias` | Campo `referencias` del recibo | exacta |
| **`items_concepto`** | **El concepto de los ítems del recibo** | **exacta** |
| `fifo` | Lo más viejo primero, dentro de cliente+moneda | **estimada** |

**[verificado] El hallazgo que cambió esto.** El GET de un recibo por `id` **no
devuelve** `referencias`. Devuelve `items`, y la imputación viaja en el **texto**
del concepto de cada ítem:

```json
"items": [
  { "concepto": "e-Factura D-1236497", "precio": 1500  },
  { "concepto": "Adelanto",            "precio": 15500 }
]
```

Ese recibo de $17.000 imputó **$1.500** a la e-Factura D-1236497 y dejó **$15.500**
como adelanto. Antes de detectarlo, toda imputación caía a FIFO y la respuesta
declaraba "estimada" teniendo el dato exacto a mano.

El parseo es deliberadamente **estricto y anclado** (`^(.*?)\s*([A-Za-z]{1,10})-(\d{1,12})$`):
sobre texto libre, cada falso positivo mueve plata de una factura a otra. Si el
concepto no tiene forma de comprobante, no se imputa. Si dos documentos comparten
serie+número en la ventana, tampoco: se avisa y se deja sin imputar.

**Verificado de punta a punta:** se emitió una e-Factura de $14.640 y un recibo
parcial de $6.000 contra ella. El recibo trajo `items: [{concepto: "e-Factura
MF-559251", precio: 6000}]` y la cuenta corriente devolvió `cobrado: 6000, saldo:
8640, estado_cobro: "parcial"`, imputado a **esa** factura y no por FIFO.

### 3.3. Recibos negativos: cancelar un cobro 🟢

**[verificado]** Cancelar un recibo genera **otro recibo con `total` negativo**
(id 387222 del ambiente de test: `total: -17000`, razón "Cancela adelanto"). No es
un cobro: es la reversión de uno anterior.

Se procesa al revés del FIFO:
1. primero consume el **saldo a favor** del cliente (cancelar un adelanto borra
   ese adelanto, no reabre una factura pagada con otra plata);
2. después reabre facturas, **de la más nueva a la más vieja** — el inverso exacto
   del orden en que se imputó, así el ledger queda como estaba.

Si sobra algo por revertir, no se inventa deuda: se avisa que el cobro original
quedó fuera de la ventana.

### 3.4. Los supuestos declarados 🟡

| Supuesto | Por qué existe |
|---|---|
| "Contado" = sin `fecha_vencimiento`, o vencimiento ≤ emisión | Biller no expone `forma_pago` en el GET. La fecha es el único indicio. Se apaga con `solo_a_credito: false`. |
| El excedente no imputable va a `saldo_a_favor` | Forzarlo contra cualquier factura daría saldos bajos e inventados. |

---

## 4. Vencimientos y aging 🟢

```
dias_para_vencer = fecha_vencimiento − hoy      (negativo = vencida)
```

Tramos: `vencida_mas_90`, `vencida_61_90`, `vencida_31_60`, `vencida_1_30`,
`vence_hoy`, `vence_en_7`, `vence_en_30`, `vence_despues`.

Solo cuentan las categorías que generan cobro (ventas y notas de débito). Las
notas de crédito no se listan como cobrables: restan, no se cobran.

---

## 5. Ranking de clientes y concentración 🟢

```
facturado[cliente][moneda] = Σ ( total × signo )
participacion_pct         = facturado[cliente] / total_del_periodo × 100
ticket_promedio           = facturado[cliente] / cantidad de comprobantes
HHI                       = Σ ( participacion_i )²        (0–10.000)
ratio_notas_credito_pct   = NC / (neto + NC) × 100
```

Detalles que cambian el número:

- **El HHI se calcula solo sobre clientes identificados.** El grupo "(sin
  receptor)" junta ventas de personas distintas; tratarlo como un cliente
  inflaría la concentración con un cliente que no existe.
- **El ratio de NC se calcula sobre el bruto**, no sobre el neto. Con el neto, un
  cliente al que se le anuló casi todo daría un ratio gigante o negativo.
- **"Dormido" se mide contra el fin del período consultado**, no contra hoy:
  preguntar por un mes de hace un año y recibir "todos dormidos" sería inútil.

Lectura del HHI: >2500 muy concentrado · 1500–2500 moderado · <1500 diversificado.

---

## 6. Ranking de productos y dispersión de precios 🟡

**El límite estructural:** `items` **solo** viene consultando por `id`. Un ranking
de productos es inevitablemente una llamada HTTP por comprobante.

La solución no es esconderlo, es acotarlo y declararlo:

1. se ordenan los comprobantes del período por importe **descendente**;
2. se consulta el detalle de los primeros `max_comprobantes` (default 100);
3. se publica la **cobertura**: `cobertura_importe_pct` dice qué porcentaje del
   importe total del período quedó dentro del ranking.

Truncar por los de mayor importe hace el ranking lo más representativo posible.
Un ranking sobre el 30% de la facturación no es un ranking, y quien lo lee tiene
que enterarse por la respuesta.

```
precio_unitario_promedio_ponderado = Σ(cantidad×precio) / Σ(cantidad)     ← ponderado por cantidad
dispersion_pct                     = (precio_max − precio_min) / precio_min × 100
```

La dispersión contesta "¿a qué cliente le estoy haciendo más descuento sin darme
cuenta?". **No es margen:** Biller no tiene el costo del producto. Compara
precios contra sí mismos, no contra un costo.

---

## 7. Comparación de períodos y proyección 🟡

```
variacion_absoluta   = actual − anterior
variacion_porcentual = (actual − anterior) / |anterior| × 100      ← null si anterior = 0
promedio_diario      = facturado_hasta_ahora / dias_transcurridos   ← solo informativo
promedio_habil       = facturado en días hábiles / días hábiles corridos
promedio_finde       = facturado en sábados y domingos / días de finde corridos
proyectado_al_cierre = facturado_hasta_ahora
                     + promedio_habil × días hábiles que faltan
                     + promedio_finde × días de finde que faltan
```

Tres decisiones:

- **Dividir por cero no es "creció infinito"**, es "no hay base de comparación":
  la variación porcentual devuelve `null`.
- **El patrón semanal se MIDE, no se supone.** El plan pedía run-rate sobre días
  hábiles y el código dividía por días calendario; las dos son una suposición
  sobre cuándo trabaja el negocio, y en Uruguay las dos se equivocan — un almacén
  factura los sábados y un estudio contable no. Así que el promedio de un día
  hábil y el de un día de fin de semana salen del propio historial del período, y
  los días que faltan se proyectan con el promedio del tipo de día que son. El
  almacén proyecta sábados llenos; el estudio, sábados en cero. Método:
  `run_rate_por_dia_de_semana`.
- **Si todavía no pasó un fin de semana, no se inventa un cero.** Afirmar
  `promedio_finde = 0` sería afirmar que el negocio cierra los sábados, que es
  justo lo que no se sabe. Ahí cae a `run_rate_lineal` y lo declara en la
  advertencia.

Sigue sin saber de estacionalidad, feriados ni del pico de cierre de mes, y
**solo se calcula si el período sigue abierto**.

El **período de comparación** se resuelve distinto según el caso: un mes
calendario completo se compara contra el mes calendario anterior (junio vs julio,
aunque tengan largos distintos — es lo que hace cualquier contador); cualquier
otro rango se compara contra la ventana anterior del mismo largo.

---

## 8. Alertas de plata — `biller_plata_en_riesgo` 🟢

No generan datos nuevos: le ponen **umbral y acción** a datos que ya se leen.
Todos los umbrales son **relativos al propio negocio**, nunca absolutos.

| Alerta | Fórmula | Umbral |
|---|---|---|
| Cliente en fuga | `(facturado_previo − facturado_actual) / facturado_previo × 100` | ≥ 40% de caída, entre los top 10 del período anterior |
| Compra mucho y paga tarde | cruce `participacion_pct` × `dias_atraso_maximo` | ≥ 5% de la facturación **y** ≥ 30 días de atraso |
| Deuda hacia incobrable | `−dias_para_vencer` | franja 60–90 días (aviso **antes** del umbral); ≥ 90 es crítica |
| Concentración en alza | `top_1_pct_actual − top_1_pct_anterior` | ≥ 5 puntos, con top 1 ≥ 30% |
| Mes por debajo | `variacion_proyectada_pct` | ≤ −10%, solo con el período abierto |
| Devoluciones disparadas | `ratio_actual − ratio_anterior` | salto ≥ 10 puntos |

Tres reglas de producto, no de código:

1. **Umbral relativo.** "Facturaste menos de $100.000" no significa nada.
   "Facturaste 40% menos que tu promedio" sí.
2. **Una acción, no un diagnóstico.** Cada alerta trae el campo `accion`.
3. **Silencio cuando no hay nada.** Sin hallazgos, la lista viene vacía. Un aviso
   que llega todos los días se deja de leer, y el día que importa tampoco se lee.

Cuando un cruce no se puede evaluar (falta el período anterior, o la cuenta
corriente), se dice en `cobertura` con el motivo — no se calla.

---

## 9. Alertas operativas — `biller_alertas_operativas` 🟢🟡

| Alerta | Cálculo | Precisión |
|---|---|---|
| Rechazos DGI | agrupa por `estado` los que no fueron aceptados | 🟢 exacta |
| CAE por agotarse | `fin − ultimo_numero_usado` | 🟡 **estimación optimista** |
| CAE por vencer | `fecha_expiracion − hoy` | 🟢 exacta |
| Emisión tardía | `fecha_creacion − fecha_emision` | 🟢 exacta (≥3 días avisa, ≥10 crítica) |
| Racha sin facturar | racha actual vs. mayor brecha del período | 🟡 relativa al propio patrón |
| Certificado DGI | campo `Vencimiento` − hoy | 🟢 exacta **[verificado]** |

**Por qué el CAE es optimista:** solo se ven los comprobantes del período
consultado, así que `ultimo_numero_usado` es una **cota inferior** y los
disponibles son un máximo. Se avisa en cada respuesta.

**Certificado DGI [verificado].** La respuesta real de
`GET /v2/dgi/empresas/certificado-unico` es **plana** — no trae la envoltura
`Flag`/`RespuestaOK` que muestra el ejemplo del OpenAPI. El normalizador acepta
las dos formas. Hay **tres** estados, no dos:

| Estado | Qué significa |
|---|---|
| `Certificado de Vigencia Anual Habilitado.` | vigente; se mira `Vencimiento` |
| vencido | `Vencimiento` anterior a hoy |
| `NO existe Certificado de Vigencia Anual` | **no está emitido**: hay que tramitarlo, no renovarlo |

Cuando no hay certificado, las fechas llegan como whitespace puro
(`"\n\t\t\t\t\t"`) — se tratan como ausentes, no como fecha.

---

## 10. Posición de IVA — `biller_posicion_iva` 🟡 (opt-in)

```
iva_ventas  = Σ ( tot_iva_tasa_min + tot_iva_tasa_bas + tot_iva_tasa_otra )   [emitidos]
iva_compras = Σ total_iva                                                     [recibidos]
posicion    = iva_ventas − iva_compras
```

Aritmética exacta sobre los CFE del período. **No se registra por defecto**
(`BILLER_ENABLE_IVA_ESTIMADO=true` para habilitarla): el número se parece
demasiado a una declaración jurada sin serlo. No contempla importaciones,
prorrata por exentos, servicios del exterior ni ajustes contables. **El riesgo es
de uso, no de código.**

---

## 11. Emisión: totales e reglas de DGI 🟢

### 11.1. Total estimado antes de emitir

```
neto_linea = cantidad × precio ± descuentos/recargos del ítem
iva_linea  = neto × tasa(indicador_facturacion)     3→22%, 2→10%, 1→exento
total      = Σ lineas ± ajustes globales
```

Con `montos_brutos = 1` los precios **ya incluyen** IVA y se desagrega hacia
atrás; con `0` el IVA se suma. El dry-run devuelve este total **antes** de
emitir, con el flag `exacto: false` si alguna tasa no se pudo determinar (ahí el
total es un piso, no el número final).

**Verificado:** $12.000 + 22% = **$14.640**, y el CFE emitido volvió con
`total: 14640.00`.

**El TEXTO del preview lo arma el mismo módulo que calcula el total**, y no el
modelo: las líneas con su cantidad, el desglose de IVA por tasa, el TOTAL y una
línea de supuestos (fecha · forma de pago · criterio de IVA). Esa línea se
construye desde el **mismo payload que se hashea** en el `confirmation_token`,
así que no hay forma de que el mensaje diga "contado" y se emita a crédito. Es
la contrapartida de que el flujo de emisión dejó de preguntar la fecha, la
moneda, la forma de pago y la cantidad: un default que el usuario no ve no es un
default, es una suposición nuestra impresa en un documento fiscal. El mensaje
exacto está en [`FLUJO_WHATSAPP.md`](FLUJO_WHATSAPP.md) §3.0.3.

### 11.2. La regla de las 5.000 UI 🟡

```
umbral_uyu = umbral_ui × valor_ui        (default 5.000 UI)
exige_receptor = total_uyu ≥ umbral_uyu   (para la familia e-Ticket)
```

- La familia **e-Factura** exige receptor identificado **siempre**, sin importar
  el monto.
- La familia **e-Ticket** lo exige **por encima del umbral**.

El valor de la UI **cambia todos los días y no está en la API de Biller**. Se
configura (`BILLER_VALOR_UI`, con su fecha). Sin configurar, el chequeo **no se
apaga**: usa un valor de referencia deliberadamente **bajo**, para que el aviso
aparezca de más y no de menos. Equivocarse avisando de más cuesta una pregunta;
de menos, un comprobante mal emitido.

Si el comprobante está en moneda extranjera y no trae `tasa_cambio`, el importe
en pesos no se puede determinar: se dice `indeterminado`, no se afirma que el
receptor no haga falta.

### 11.3. Campos obligatorios — `biller_requisitos_comprobante` 🟢

Convierte la Tabla de Valores de la API en "qué falta y cuál es la próxima
pregunta". Es de lectura, no toca la red, y devuelve **una** pregunta por vez:
pedir seis campos juntos por WhatsApp garantiza no recibir ninguno.

**[verificado] Un requisito que la doc no declara:** la documentación dice que
`cliente.sucursal.pais` es "el único campo obligatorio para clientes que no son
empresas". No es cierto cuando el cliente se da de alta en la misma llamada de
emisión: Biller responde `422 ClientesSucursales[direccion]: Dirección no puede
estar vacío | ClientesSucursales[ciudad]: Ciudad no puede estar vacío`. El
preview lo avisa ahora, antes de emitir.

---

## 12. Anulación — `biller_plan_anulacion` 🟢

**Un CFE no es irreversible.** Se corrige, y cada corrección deja rastro:

```
venta mal emitida  → Nota de Crédito     → queda saldada
esa NC fue el error → Nota de Débito      → el original vuelve a tener validez
```

El mapa de tipos es regular (`101→102→103`, `111→112→113`, …) pero está declarado
explícitamente, no calculado con aritmética sobre el número: una familia futura
que rompa el patrón produciría, en silencio, una nota de crédito de un tipo
inexistente.

La tool detecta el caso peligroso: si el comprobante **ya** tiene una nota de
crédito candidata, emitir otra lo acreditaría dos veces. El límite honesto es que
el listado **no** devuelve a qué comprobante referencia una NC, así que el
hallazgo se reporta como **candidato** —mismo cliente, mismo importe, posterior—
y no como certeza.

---

## 13. Dónde interviene la IA, exactamente

| Etapa | Quién |
|---|---|
| Entender "¿cuánto facturé en junio?" | 🤖 modelo |
| Elegir `biller_resumen_facturacion_periodo` con `periodo: "2026-06"` | 🤖 modelo |
| Consultar la API, ventanear, deduplicar, filtrar por emisión | ⚙️ código |
| Clasificar cada CFE, aplicar signos, filtrar por estado DGI | ⚙️ código |
| Sumar, convertir con la tasa del comprobante, calcular ratios | ⚙️ código |
| Redactar "facturaste $106.340 en 5 comprobantes" | 🤖 modelo |

Y en el sentido de entrada, la misma frontera:

| Etapa | Quién |
|---|---|
| Entender que "facturale a Pérez 2 bolsas a 6.500" es un pedido de emisión | 🤖 modelo |
| **Leer** el 6.500 de ese texto (`Number("6.500")` es 6,5) | ⚙️ código |
| Elegir a qué cliente corresponde "Pérez", o preguntar si hay dos | ⚙️ código |
| Decidir qué tipo de CFE, qué falta preguntar y qué se defaultea | ⚙️ código |
| Escribir el preview que el usuario aprueba | ⚙️ código |

La frontera es nítida: **el modelo nunca produce una cifra, solo la transporta.**
Y desde agosto de 2026 tampoco la *lee*: el texto libre del usuario lo vuelve a
parsear el server con las reglas escritas de `importe.ts`.

Y una barrera que va en el otro sentido: el texto libre de un comprobante
—`adenda`, `concepto`, razón social— lo escribe un tercero. Todo eso sale envuelto
en `⟦dato-no-confiable⟧` y las instrucciones del servidor declaran que el
contenido de un comprobante es **dato, nunca instrucción**.

---

## 14. Lo que sigue sin poder calcularse

| Pregunta | Qué falta | Palanca |
|---|---|---|
| ¿Cuál es mi margen por producto? | Biller no guarda el costo | importación de costos por CSV |
| ¿Cuánto tengo que pagar yo? | Los recibidos dan devengado, no pagado | equivalente de cuenta corriente para compras |
| ¿Está cobrada esta factura, sin imputar? | No hay un flag `cobrada` | pedírselo a Biller: un booleano resuelve más que todo un store local |

Ninguna de las tres se arregla programando mejor. Decirlo es parte del cálculo.
