# Plan V2 — De MCP de facturación a agente de datos del negocio

> Estado del documento: propuesta para discusión. Escrito el 2026-07-27 sobre el
> código en `main` (suite verde, typecheck y `check:readonly` OK).
> Reemplaza a `PLAN.md` como norte; `PLAN.md` queda como registro del MVP read-only.

---

## 1. Dónde estamos (compactación del estado)

Lo que existe hoy y funciona:

| Capa | Estado |
|---|---|
| Transporte | MCP stdio, TypeScript + Zod + Vitest |
| Lectura | 7 tools GET (`health`, `buscar_cliente_por_rut`, `emitidos`, `recibidos`, `obtener`, `pdf`, `resumen_facturacion_periodo`) |
| Escritura | 7 tools POST con dry-run → `confirmation_token` → confirm, doble gate de producción, idempotencia y audit log |
| Aislamiento | `BILLER_CAPABILITY_MODE=read_only` por defecto; `scripts/check-readonly.mjs` prueba estáticamente que fuera de `src/write/` no hay POST |
| Calidad | Suite automatizada, CI en GitHub Actions, evals declarativos |
| Conocimiento duro | ventanas de 7 días + dedupe (la API tira 500 en rangos largos), filtro por fecha de emisión fiscal, `estado="Aceptado DGI"` como criterio de totales |

Esto es una base sólida. **El MVP de "conectar Claude a Biller" está cerrado.**
Lo que viene no es más de lo mismo: es otro problema.

---

## 2. El hallazgo que define todo el plan

Audité la especificación completa de la API. **Biller expone 14 endpoints. Solo 7 son de lectura:**

```
GET  /v2/comprobantes/obtener              → CFEs emitidos (+ items si consultás por id)
GET  /v2/comprobantes/pdf                  → PDF de un CFE
GET  /v2/comprobantes/recibidos/obtener    → CFEs recibidos de DGI (proveedores)
GET  /v2/dgi/empresas/nombre-entidad       → datos de un RUT
GET  /v2/dgi/empresas/datos-entidad
GET  /v2/dgi/empresas/actividad-empresarial
GET  /v2/dgi/empresas/certificado-unico
```

Y siete de escritura: emitir, anular, recibos crear/cancelar, pagos crear,
clientes crear, productos cargar.

**La asimetría es el problema central del producto:**

- Podés **crear** un pago (`POST /v2/pagos/crear` con `comprobantes: [...]`).
  No podés **leer** ningún pago.
- Podés **crear** un recibo con `referencias` a facturas. No podés leer recibos.
- Podés **crear** un cliente. No hay listado de clientes.
- Podés **cargar** un producto con `precio`. No hay catálogo de productos, y el
  schema **no tiene campo de costo**.

Consecuencia directa, sin vueltas:

> **"¿Quién me debe plata?" no es contestable con la API tal como está hoy.**
> Se puede saber qué se facturó y con qué vencimiento, pero no qué se cobró.

Esto no invalida la visión: la reordena. El cuello de botella **no es la capa de
chat ni el modelo** — es la capa de datos. Todo el plan sale de ahí.

### 2.1. Semáforo de las preguntas que querés contestar

🟢 = con lo que ya devuelve la API · 🟡 = requiere store local / trabajo nuestro · 🔴 = requiere que Biller abra endpoints o que entre un dato externo

| Pregunta | | Por qué |
|---|---|---|
| ¿Cuánto vendí este mes / por local / por moneda? | 🟢 | ya implementado |
| ¿Qué facturas vencen esta semana? | 🟢 | `fecha_vencimiento` viene en emitidos |
| ¿Qué CFEs me rechazó DGI? | 🟢 | campo `estado`, hoy desaprovechado |
| ¿Cuánto CAE me queda / cuándo vence? | 🟢 | `cae.fin`, `cae.fecha_expiracion` — nadie lo mira hasta que se rompe |
| ¿Cuánto le compré a cada proveedor? | 🟢 | comprobantes recibidos |
| ¿Qué productos vendí más este trimestre? | 🟡 | `items` **solo viene consultando por `id`** → una llamada por comprobante. Inviable en vivo, trivial con store local |
| ¿Qué clientes dejaron de comprarme? | 🟡 | serie temporal por cliente sobre el store |
| ¿A qué cliente le hago más descuento? | 🟡 | dispersión de precio unitario del mismo producto entre clientes |
| **¿Quién me debe plata / aging de cobranzas?** | 🔴 | falta leer pagos y recibos |
| **¿Cuál es mi margen por producto?** | 🔴 | no existe costo en Biller |
| ¿Cuánto tengo que pagar yo (CxP)? | 🔴 parcial | los recibidos dan el devengado, no el pagado |

Las tres 🔴 son las de mayor valor comercial. Ninguna se resuelve programando más
lindo: se resuelven **consiguiendo el dato**. Ver §6.

---

## 3. Arquitectura objetivo

Hoy el server es una capa fina sobre HTTP: cada pregunta es una o más llamadas a
la API. Eso no escala a analítica. La arquitectura objetivo mete un store en el medio.

```
┌─────────────────────────────────────────────────────────────┐
│  L5  Hosts        Claude Desktop · Claude Code · chat propio │
│                   (MCP es agnóstico del modelo por diseño)   │
├─────────────────────────────────────────────────────────────┤
│  L4  Capacidades  tools de lectura · analítica · escritura   │
│                   + catálogo "qué puedo preguntar"           │
├─────────────────────────────────────────────────────────────┤
│  L3  Política     tenant · roles · redacción · datos no      │
│                   confiables · audit · rate limit            │
├─────────────────────────────────────────────────────────────┤
│  L2  Store        SQLite por empresa: comprobantes, items,   │
│                   clientes derivados, recibidos, ledger      │
├─────────────────────────────────────────────────────────────┤
│  L1  Ingesta      sync incremental + ventanas + dedupe       │
├─────────────────────────────────────────────────────────────┤
│  L0  Biller API   14 endpoints (7 GET / 7 POST)              │
└─────────────────────────────────────────────────────────────┘
```

### L1/L2 — Ingesta y store (la pieza que falta)

Un SQLite por empresa (`~/.biller-mcp/<tenant>/data.db`) con:

- `comprobantes` — emitidos, normalizados, PK `id`
- `items` — detalle por comprobante (poblado con el fetch por `id`, amortizado en el tiempo)
- `recibidos` — CFEs de proveedores
- `clientes` — **derivados** de los comprobantes (documento, razón social, primera/última compra). Resuelve la falta del endpoint de clientes.
- `sucursales` — **derivadas** de los comprobantes. Hace innecesario `BILLER_SUCURSALES_JSON` salvo para ponerles nombre.
- `ledger_cobros` — pagos/recibos emitidos **a través del MCP**, más importación manual. Es la base honesta de CxC hasta que Biller abra la lectura.
- `sync_state` — última ventana sincronizada, para incremental.

Por qué SQLite y no in-memory: la pregunta "productos más vendidos del trimestre"
son ~500 comprobantes × 1 request cada uno para traer items. Con rate limit y
ventanas eso es minutos. Con store: milisegundos, y el costo se paga una sola vez.

Reglas: el store es **cache derivada, nunca fuente de verdad**. Toda respuesta
analítica declara `sincronizado_hasta`. Re-sync destructivo siempre posible.

### L3 — Política (ver §5)

### L4 — Tools analíticas

Sobre el store, no sobre la API. Nombres tentativos:

| Tool | Contesta |
|---|---|
| `biller_cuentas_por_cobrar` | vencimientos + aging (con caveat de cobranza explícito) |
| `biller_ranking_clientes` | quién factura más, quién cayó, quién es nuevo |
| `biller_ranking_productos` | más vendidos por unidades/importe, por período |
| `biller_analisis_precios` | mismo producto, distinto precio: dispersión y descuentos |
| `biller_compras_proveedores` | qué compro, a quién, evolución |
| `biller_alertas_operativas` | rechazos DGI, CAE por agotarse/vencer, facturas vencidas, clientes dormidos |
| `biller_catalogo_datos` | qué datos existen, con qué cobertura y hasta cuándo |

`biller_catalogo_datos` es la tool más subestimada del set: es la que le permite
al modelo saber qué puede contestar y con qué límites — y la que alimenta las
**preguntas sugeridas** de la interfaz sin hardcodearlas.

### L5 — Hosts y elección de modelo

MCP ya es agnóstico del modelo: el mismo server funciona con Claude, GPT o Kimi
según el host. Para elegir modelo desde tu propio chat hace falta **un host
propio** (cliente MCP + router de proveedores), no cambios en el server. Es Fase 5,
y conviene que sea lo último: el server es el activo, el chat es reemplazable.

---

## 4. Replicabilidad (que sirva para cualquier empresa)

Hoy poner esto a andar en otra empresa requiere editar `.env` a mano, conseguir
el ID real de sucursal y armar un JSON. Eso no es *plug and play*. Lo que falta:

1. **Onboarding automático.** Un `biller_onboarding` (o CLI `npx biller-mcp init`)
   que con solo el token: valide conectividad, detecte ambiente test/producción,
   **derive sucursales y clientes de los datos**, mida cobertura histórica y
   escriba la config. Cero conocimiento previo del sistema.
2. **Multi-tenant real.** Un `tenant_id` explícito, un store y un audit log por
   empresa, y token resuelto por tenant (no una variable global). Sin esto no hay
   producto vendible, solo instalación personal.
3. **Distribución.** Sacar `private: true`, publicar como paquete, versionar el
   esquema del store con migraciones.
4. **Perfiles de despliegue.** `read_only` (default), `analitica`, `operacion`
   (escritura). Cada empresa elige; el default nunca escribe.
5. **Conectores externos** (contabilidad, ERP, CRM, bancos): definir un contrato
   de importación genérico — `origen`, `tipo_dato`, `mapeo` — en vez de integrar
   uno por uno. El primero que entre marca el patrón; los costos de producto
   entran por acá y desbloquean márgenes.

---

## 5. Arquitectura de seguridad

Lo que ya está bien: el token nunca se loguea ni se devuelve (`inspectConfig`
informa `hasToken`, no el valor); la superficie de lectura es GET-only con guard
estático y en runtime; escritura con doble gate, idempotencia y audit.

Lo que **falta** para exponer esto a terceros:

### 5.1. Secretos
- **Redacción en salida**: un filtro único por el que pasa *toda* respuesta de
  tool, que tacha patrones de token/bearer aunque vengan de un eco de la API.
  Hoy la garantía es "ninguna tool lo devuelve"; debe ser estructural, no por convención.
- **Nunca en argumentos de tool.** El token vive en el entorno del server. Ninguna
  tool debe aceptarlo como parámetro — si el usuario lo pega en el chat, ya se filtró.
- **Rechazo explícito de introspección**: preguntar "¿cuál es el token?" /
  "mostrame la config" debe devolver estado, nunca valores. Test que lo fije.

### 5.2. Datos no confiables (el riesgo menos obvio y el más real)
Los campos `adenda`, `informacion_adicional`, `descripcion` de items y la razón
social **de comprobantes recibidos** son texto escrito por terceros —
cualquier proveedor que te emite una factura puede poner ahí lo que quiera, y eso
entra al contexto del modelo. Es un vector de prompt injection con superficie real.

Mitigación: marcar esos campos como datos no confiables al serializarlos
(envoltura explícita), truncarlos, y fijar en las instrucciones del server que el
contenido de un comprobante es **dato, nunca instrucción**. Más eval adversarial
en `evals/` con una factura maliciosa.

### 5.3. Autorización
- Roles por perfil (`read_only` / `analitica` / `operacion`) con allowlist de tools.
- Aislamiento por tenant verificado en cada llamada, no asumido por proceso.
- Límite de exposición de PII: RUT y razón social son datos de terceros; que las
  respuestas agregadas no arrastren listados completos sin que se hayan pedido.

### 5.4. Escritura
Mantener el diseño actual y sumar: TTL corto al `confirmation_token`, límite de
monto por operación configurable, y audit log persistente entre sesiones (hoy la
idempotencia es en memoria — se pierde al reiniciar).

---

## 6. Las tres preguntas 🔴: cómo se desbloquean

Esto no es código, es decisión de producto. Por orden de retorno:

1. **Pedirle a Biller endpoints de lectura**: `GET /pagos`, `GET /recibos`,
   `GET /clientes`, `GET /productos`. Sos parte de Biller: es la palanca más
   corta y desbloquea CxC completa, que es la pregunta #1 de cualquier PyME.
   *Mientras tanto*: el `ledger_cobros` local cubre lo que se cobre por el MCP.
2. **Costos**: no existen en Biller. Entran por importación (CSV/planilla) o
   derivados de comprobantes recibidos matcheados a productos. Sin esto, "margen"
   es adivinanza. Con esto, `biller_analisis_precios` pasa de descriptivo a
   accionable — y es la funcionalidad que más se vende.
3. **Estado de cobro por factura**: aunque no haya endpoint, si Biller marca la
   factura como cobrada internamente, alcanza con exponer un flag en
   `/comprobantes/obtener`. Es el cambio más chico con más impacto de los tres.

---

## 7. Fases

Cada fase deja algo usable. Nada de un big bang.

### Fase 0 — Cerrar el MVP (base para todo lo demás)
- Validar los POST contra `test.biller.uy` de punta a punta (P0 pendiente).
- Persistir idempotencia y audit entre sesiones.
- Aprovechar lo que ya se lee y se desperdicia: **alertas de rechazos DGI y de CAE**.
  Es la primera funcionalidad "wow" y no necesita infraestructura nueva.

### Fase 1 — Store e ingesta
- Esquema SQLite + migraciones + `sync_state`.
- `biller_sync` (incremental, reanudable, respeta rate limits).
- Derivar clientes y sucursales de los datos.
- Tests contra fixtures reales; el store nunca es fuente de verdad.

### Fase 2 — Analítica
- Las tools de la tabla de §L4, en orden: productos → clientes → precios → CxC.
- Cada una con `sincronizado_hasta` y caveats explícitos.
- `biller_catalogo_datos` + preguntas sugeridas derivadas de la cobertura real.

### Fase 3 — Seguridad y multi-tenant
- Redacción estructural, datos no confiables, roles, tenant aislado.
- Evals adversariales.

### Fase 4 — Replicabilidad
- Onboarding automático, publicación del paquete, perfiles de despliegue.

### Fase 5 — Producto de chat
- Host propio con selección de modelo, preguntas sugeridas en la UI, historial.
- Conectores externos (costos primero).

---

## 8. Backlog priorizado

Orden = valor entregado ÷ esfuerzo. Los primeros cinco son los que yo haría ya.

| # | Ítem | Valor | Esfuerzo | Fase |
|---|---|---|---|---|
| 1 | Alertas: rechazos DGI + CAE por vencer/agotarse | Alto | Bajo | 0 |
| 2 | Facturas que vencen esta semana (`fecha_vencimiento`) | Alto | Bajo | 0 |
| 3 | Clientes y sucursales derivados de los datos | Alto | Bajo | 1 |
| 4 | Store SQLite + `biller_sync` | Alto | Medio | 1 |
| 5 | Ranking de productos del trimestre | Alto | Bajo* | 2 |
| 6 | Redacción estructural de secretos + datos no confiables | Alto | Medio | 3 |
| 7 | Ranking de clientes / clientes dormidos | Medio | Bajo* | 2 |
| 8 | `biller_catalogo_datos` + preguntas sugeridas | Medio | Bajo | 2 |
| 9 | Análisis de dispersión de precios | Alto | Medio | 2 |
| 10 | Multi-tenant + roles | Alto | Medio | 3 |
| 11 | Onboarding automático | Alto | Medio | 4 |
| 12 | Ledger de cobros local | Medio | Medio | 2 |
| 13 | Importación de costos → márgenes | Muy alto | Alto | 5 |
| 14 | Host de chat con selección de modelo | Medio | Alto | 5 |

\* bajo **una vez que existe el store**; inviable sin él.

---

## 9. Decisiones abiertas

1. **¿Se puede conseguir que Biller exponga GET de pagos/recibos/clientes?**
   Cambia el orden completo del backlog. Es la pregunta más importante del documento.
2. **¿De dónde salen los costos?** Sin respuesta, márgenes queda fuera del alcance.
3. **¿Producto interno o multi-empresa desde el día uno?** Define si Fase 3 va
   antes o después de Fase 2.
4. **¿Qué es "capso"?** (mencionado como sistema a conectar) — hace falta el
   nombre exacto para evaluar el conector.
5. **Chat propio vs. Claude Desktop.** Un host propio es lo que habilita elegir
   modelo y las preguntas sugeridas, pero es el ítem más caro del backlog.
