# Mapa: emisión y anulación de comprobantes, completas

`wayfinder:map` · [cómo funciona este tracker](README.md)

## Destino

El flujo de **emitir** (e-Ticket 101, e-Factura 111) y **anular** (NC 102, NC 112)
funcionando de verdad contra `test.biller.uy`, desde WhatsApp y desde Claude
Desktop por MCP directo — con la casuística operativa cubierta, no solo el
camino feliz.

Se llega cuando un dueño de PyME puede emitir y anular sin saber qué es un 101,
sin que ningún caso lo deje trabado o con un comprobante mal emitido, y sin que
nadie tenga que revisar el JSON.

## Notas

**Este mapa lleva ejecución adentro**, no solo decisiones: un ticket se cierra
cuando el comportamiento está implementado, testeado y verificado contra la API
real. El destino es el flujo andando, no un documento que lo describa.

**Dominio:** facturación electrónica de Uruguay (DGI/CFE) sobre la API de Biller.
Proyecto vibecodeado, **no va a producción**: `test.biller.uy` siempre.

**Skills a consultar en cada sesión:** `/grilling` y `/domain-modeling` ante
cualquier duda de modelado; `/prototype` cuando la pregunta es "cómo se ve".

**Antes de escribir tests, probar contra la API real.** Cuatro de siete
comportamientos verificados contradicen al OpenAPI: ver
[`../../docs/`](..) y la doc oficial en `~/Downloads/api-1.json`, cuyo cuerpo de
emisión vive en el `description` del endpoint, no en un schema.

### Restricciones ya fijadas por el dueño del producto

| Tema | Decisión |
|---|---|
| Tipos de CFE | Solo **101, 111, 102, 112**. Nada de notas de débito. |
| Fecha de emisión | **Siempre hoy.** No se emite con fecha pasada. |
| Precio e IVA | **Preguntar siempre** si el precio ya incluye IVA. |
| `numero_interno` | **Generarlo automáticamente**, formato a elección. |
| Valor de la UI | Cambia el **1° de enero** de cada año. |
| Tasa de cambio | Si el sistema la trae sola, se usa esa. |
| Cliente | Lista derivada de a quién se le facturó + alta con RUT. |
| Datos de DGI | Se buscan por RUT y **se muestran para confirmar**. |
| Sucursal | Fija por número de teléfono (la predeterminada). |
| Anular factura ya cobrada | **Bloquear y avisar.** |
| Anular desde WhatsApp | Permitido, con **doble confirmación**. |
| Anulación parcial | Permitida, **siempre ofreciendo opciones para elegir**. |
| CAE agotado / DGI caído | Recomendar seguir en la interfaz de Biller. |

## Decisiones hasta ahora

<!-- una línea por ticket cerrado; el detalle vive en el ticket -->

_(ninguna todavía — el mapa se acaba de trazar)_

## No especificado todavía

- **Permisos por persona.** Hoy la allowlist es un número de teléfono. Si además
  del dueño lo usa un empleado, ¿emite igual, o solo consulta? Se ve después.
- **Tope de monto.** Existe `BILLER_MAX_MONTO_UYU` sin setear. Falta saber si
  tiene sentido un techo y de cuánto.
- **Store local.** `docs/STORE.md` propone cachear datos localmente. Si aparece,
  cambia cómo se resuelven clientes y productos — pero recién se puede decidir
  cuando estén cerradas las reglas de emisión.
- **El menú con anulación adentro.** Las 10 filas de WhatsApp ya están usadas.
  Cuando el flujo de anulación esté definido habrá que ver si entra como fila,
  como intención oculta, o si algo sale.
- **Notas de crédito sobre comprobantes de varios ítems.** La anulación parcial
  se complica cuando hay que elegir cuál ítem se acredita; depende de qué
  permita la API.

## Fuera de alcance

- **Notas de débito (103, 113)** y por lo tanto **revertir una anulación** — el
  dueño las descartó explícitamente.
- **Exportación (121-124)**, **eRemito (181)**, **eResguardo (182)** y **venta
  por cuenta ajena (131-133, 141-143)** — más complejidad de la que el flujo
  soporta hoy.
- **Producción.** El producto no va a `biller.uy` real.
