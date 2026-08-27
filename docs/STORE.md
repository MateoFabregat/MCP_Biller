# Store local: cuál es el camino correcto

> No implementado. Este documento es la recomendación pedida antes de construir.

## 1. El problema, con números

`items` —el detalle de líneas de un comprobante— **solo viene consultando por
`id`**. No viene en el listado. Entonces, para saber qué productos se vendieron
en un trimestre:

| | |
|---|---|
| Comprobantes de un trimestre (PyME chica) | ~500 |
| Requests para el listado (ventanas de 7 días) | ~13 |
| Requests para traer los `items` | **500** |
| Rate limit de la API | 30 req/s (1 req/s en DGI y recibidos) |
| Tiempo mínimo teórico | ~17 s |
| Tiempo real con latencia y reintentos | **2–5 minutos** |

Dos o tres minutos para contestar "¿qué vendí más?" no es una funcionalidad
lenta: es una funcionalidad que nadie usa. Y ese costo se paga **cada vez**,
aunque los datos no hayan cambiado.

Con store: se paga una vez, y las consultas siguientes son milisegundos.

## 2. Lo que NO hay que hacer

**Cachear las respuestas HTTP.** Es lo primero que se le ocurre a cualquiera y
no resuelve el problema: un caché de respuestas sigue sin poder contestar
"productos más vendidos ordenados por importe", porque eso es una consulta
*analítica* sobre datos *relacionales*, no una repetición de una request. Se
necesita poder agrupar, ordenar y filtrar — o sea, SQL.

**Guardar un JSON grande en disco.** Funciona hasta los ~5.000 comprobantes y
después hay que cargar todo en memoria para cada pregunta. Es una base de datos
mal hecha.

## 3. La recomendación: SQLite, con una capa de abstracción fina

### Por qué SQLite y no Postgres

| | SQLite | Postgres |
|---|---|---|
| Instalación para el usuario | ninguna (un archivo) | servidor + credenciales |
| Consultas analíticas | sí | sí |
| Concurrencia de escritura | limitada | alta |
| Costo | 0 | hosting |
| Encaja con "MCP local" | **sí** | no |

El MCP corre en la máquina del usuario o en un contenedor chico. Pedirle a una
PyME que levante un Postgres para usar el chat de facturación mata el producto.
SQLite es un archivo en `~/.biller-mcp/<tenant>/data.db` y se acabó.

**La objeción real es Vercel**, no el tamaño: el filesystem de Vercel es de solo
lectura y efímero. Ver §5.

### Esquema mínimo

```sql
comprobantes(id PK, tipo, serie, numero, fecha_emision, fecha_creacion,
             fecha_vencimiento, moneda, tasa_cambio, total, estado,
             sucursal, cliente_rut, cliente_nombre, indicador_cobranza_propia,
             sincronizado_en)
items(comprobante_id FK, linea, codigo, concepto, descripcion,
      cantidad, precio, impuesto_tasa, descuento_cantidad)
recibidos(rut_emisor, tipo, serie, numero, fecha, moneda,
          total_neto, total_iva, monto_total, total_retenido,
          PRIMARY KEY(rut_emisor, tipo, serie, numero))
sync_state(recurso, ultima_fecha_sincronizada, ultimo_run, items_pendientes)
```

`clientes` y `sucursales` **no son tablas, son vistas** derivadas de
`comprobantes`. Biller no expone esos endpoints, y derivarlas garantiza que
nunca se desincronicen.

### Reglas que no se negocian

1. **El store es caché derivada, NUNCA fuente de verdad.** Ante cualquier duda,
   Biller manda. Un re-sync destructivo debe ser siempre posible.
2. **Toda respuesta analítica declara `sincronizado_hasta`.** Sin eso, el
   usuario no puede distinguir "vendiste poco" de "faltan datos por sincronizar".
   Es el mismo principio que ya aplican `estrategia` en la cuenta corriente y
   `es_estimacion` en la posición de IVA.
3. **Los `items` se traen de forma incremental y amortizada**, priorizando los
   comprobantes más recientes. Nunca en una ráfaga de 500 requests.
4. **El esquema se versiona con migraciones** desde el día uno.

### Sincronización

```
biller_sync(desde?, hasta?, incluir_items?, max_requests?)
```

- **Incremental**: arranca desde `sync_state.ultima_fecha_sincronizada`.
- **Reanudable**: si se corta, la próxima corrida sigue donde quedó. Sin esto,
  un timeout obliga a empezar de cero y la sincronización inicial nunca termina.
- **Acotada**: `max_requests` como tope duro por corrida, para que el usuario
  pueda decir "traé lo que puedas en 30 segundos".
- **Los comprobantes viejos no cambian**, salvo el `estado` mientras DGI
  responde. Conviene re-verificar solo los últimos ~15 días y los que están en
  `Pendiente DGI`.

### La capa de abstracción

Un `StoreAdapter` con cuatro métodos (`upsertComprobantes`, `upsertItems`,
`query`, `syncState`) e implementación SQLite. **No para soportar cinco motores
—eso es sobre-ingeniería— sino para que la alternativa remota de §5 sea un
archivo nuevo y no una reescritura.**

## 4. Qué se desbloquea

| Funcionalidad | Score en el brainstorm |
|---|---|
| Ranking de productos (unidades e importe) | 5 |
| **Dispersión de precios / descuento real por cliente** | 5 |
| Catálogo de productos derivado | 4 |
| Serie temporal por cliente → predicción de abandono | 4 |
| Comparaciones históricas largas sin re-consultar | — |

La segunda es la que más se vende: *"¿a qué cliente le estoy haciendo más
descuento sin darme cuenta?"* Ninguna PyME lo sabe, todas pierden margen ahí, y
no necesita el dato de costo —que Biller no tiene— porque compara precios contra
sí mismos.

## 5. El conflicto con Vercel, y cómo se resuelve

**Vercel y SQLite local son incompatibles.** El filesystem es de solo lectura
(salvo `/tmp`, que es efímero y no se comparte entre instancias). Un `data.db`
en Vercel se pierde en cada deploy y no existe entre invocaciones.

Hay tres caminos honestos:

### Opción A — Store local, deploy local *(recomendada para empezar)*
El MCP con store corre donde el usuario tiene disco: su máquina, un VPS chico,
un contenedor. Vercel queda **solo** para el endpoint que consulta Kapso, sin
analítica de productos.

- Sin costo, sin infraestructura nueva, empieza a andar hoy.
- Requiere que algo esté prendido para que Kapso lo alcance.

### Opción B — SQLite gestionado (Turso / libSQL)
Turso es SQLite sobre HTTP: **el mismo SQL, el mismo esquema, misma abstracción**,
pero accesible desde serverless. Plan gratuito holgado para el volumen de una PyME.

- Compatible con Vercel y con el diseño de §3 sin cambios de modelo.
- Suma una dependencia externa y credenciales nuevas que hay que proteger.

**Si el objetivo es que esto viva en Vercel, esta es la opción.**

### Opción C — Postgres (Vercel Postgres / Neon / Supabase)
Sirve si más adelante hay multi-tenant real con varias empresas escribiendo a la vez.

- Es la única que escala a producto multi-empresa.
- Es la más cara y la más pesada de operar. **Hoy sería resolver un problema que
  todavía no existe.**

### Mi recomendación concreta

> **Diseñá para SQLite con el `StoreAdapter` de §3, y arrancá con la Opción A.**
> Si el deploy en Vercel se vuelve el canal principal, migrá a **Turso**: mismo
> SQL, mismo esquema, un adapter nuevo. Postgres, solo cuando haya una segunda
> empresa real.

El orden importa: empezar por Postgres "por las dudas" agrega semanas de
infraestructura antes de saber si la funcionalidad de productos se usa.

## 6. Riesgo a tener presente

El store guarda **la contabilidad completa de la empresa en un archivo sin
cifrar**. Hoy los datos solo pasan por memoria. Antes de que el store exista de
verdad hay que decidir: permisos del archivo (0600), si se cifra en reposo, y
qué pasa con ese archivo cuando la empresa deja de usar el producto. No es
bloqueante para un prototipo; sí lo es para dárselo a un cliente.
