# Ola C — Auditoría de septiembre 2026

Seis revisores adversariales en Fable (tres de seguridad, tres de código),
anclados en dos skills comunes (`security-review` y `adversarial-reviewer`), y
ejecución en Sonnet contra estas issues.

## Estado al cierre del 04/09/2026

**Hechas y verificadas: 00 a 18, 20 y 21.** Veintiuna issues.
**Escritas para la ola siguiente:** 19 (salida en los submenús), 22 (catálogo
único de tipos de CFE), 23 (reintentar el 429), 24 (el cobro con botones).

Cierre: **1886 tests verdes**, typecheck limpio, evals del enrutador 44/44,
`check:readonly` OK.

## Estado

| # | Issue | Severidad | Origen |
|---|---|---|---|
| 00 | Un header Host inválido tumba el proceso | **ALTA** | Seguridad Kapso |
| 01 | El logger acumula secretos, no los reemplaza | media | Seguridad multi-tenant |
| 02 | Ids de empresa en minúsculas | media | Seguridad multi-tenant |
| 03 | Serverless no le cuenta el registro a un anónimo | baja | Seguridad multi-tenant |
| 04 | Permisos de archivos preexistentes | baja | Seguridad multi-tenant |
| 05 | El valor de la UI puede estar vencido o ser un tipeo | **ALTA** | Arquitectura |
| 06 | Las tasas de IVA viven en dos lugares | **ALTA** | Arquitectura |
| 07 | Una sola versión del server | baja | Arquitectura |
| 08 | El opt-in de IVA estimado no se hereda | baja | Arquitectura |
| 09 | Un borrador cancelado no resucita | media | Auditoría del diff |
| 10 | El replay tolera la línea partida | media | Seguridad Kapso |
| 11 | Un reclamo por deudor por día, sin importar quién lo pide | baja | Seguridad Kapso |
| 12 | Tope al texto que entra al enrutador | baja | Seguridad Kapso |
| 13 | Endurecer el registro fiscal de idempotencia | **ALTA ×3** | Auditoría del diff |
| 14 | El preview no puede quedarse sin ítems | media | Auditoría del diff + bugs |
| 15 | La última red del preview se pasa por un carácter | media | Auditoría del diff |
| 16 | Una barra no siempre es una fracción | media | Auditoría del diff + bugs |
| 17 | Filtrar la cuenta corriente por cliente filtra TODO | **CRÍTICA** | Bugs y contratos |
| 18 | "Pará" y "cancelá" escritos cierran la factura | ALTA | Flujo conversacional |
| 19 | Todo submenú tiene salida de un toque | ALTA | Flujo conversacional |
| 20 | El precio escrito se lee | ALTA | Flujo conversacional |
| 21 | La dirección no es un pedido | media | Flujo conversacional |

## Ejecución

Ocho agentes en Sonnet, cada uno dueño de un conjunto de archivos disjunto para
que no se pisen entre sí. El orden lo decidió la severidad, no el tamaño.

| Ejecutor | Issues | Archivos propios |
|---|---|---|
| Transporte | 00 | `transport/http.ts`, `index.ts` |
| Multi-empresa | 01, 02, 03, 04a, 08 | `logger.ts`, `tenants/registry.ts`, `transport/serverless.ts`, `write/audit.ts`, `scripts/onboard.mjs` |
| Idempotencia fiscal | 13 | `write/idempotency.ts` |
| Preview | 14, 15 | `services/calcularTotales.ts`, `kapso/render.ts` |
| Cantidades | 16 | `services/importe.ts`, `kapso/extraerPedido.ts` |
| Cuenta corriente | 17 | `tools/cuentaCorriente.ts` |
| Stores de Kapso | 09, 10, 11, 04b | `kapso/borradorStore.ts`, `kapso/webhookReplay.ts`, `kapso/idempotency.ts` |
| Flujo | 12, 18, 20, 21 | `tools/menuWhatsapp.ts`, `tools/emisionGuiada.ts`, `kapso/{webhook,enrutador,intenciones,emision}.ts` |
| Fiscal y config | 05, 06, 07 | `config.ts`, `constants.ts`, `biller/requisitos.ts`, `tools/health.ts`, `services/anulacion.ts` |

Las issues 19, 22, 23 y 24 quedaron escritas y sin ejecutar: la 19 depende de la
18, y las otras tres son de la ola siguiente.

## Backlog: lo que quedó planificado y no entró en esta ola

Sale de los mismos seis informes. Ordenado por lo que más duele.

1. **Un catálogo único de tipos de comprobante.** Hoy agregar o reclasificar un
   tipo toca **cinco tablas en tres archivos** (validación, categoría para
   sumar, familia para el receptor, y cuatro sets de casos especiales). Las
   etiquetas ya divergen entre tablas. El modo de falla: DGI publica un tipo
   nuevo, se agrega donde valida y se olvida donde suma, y el total sube en vez
   de bajar. Nada falla.
2. **Reintentar el 429 de Biller** con su `Retry-After`. Es el único 4xx que por
   definición es transitorio, y hoy aborta una consulta de 53 ventanas entera.
3. **La tool fiscal sabe cómo se dibuja WhatsApp.** El presupuesto de 1024
   caracteres de un canal decide el resumen que se hashea en el token de
   confirmación. Agregar un segundo canal obliga a tocar la emisión.
4. **Achicar la ventana ante una respuesta de más de 2 MB** en vez de tumbar la
   consulta entera: hoy una empresa grande tiene un techo silencioso.
5. **Botones de WhatsApp para "Registrar un cobro".** Es la única fila visible
   que mueve plata confirmando con un "dale" interpretado por el modelo, sin el
   binding por hash que sostiene el preview de emisión.
6. **Segundo nivel del menú** (ver `docs/FLUJO_WHATSAPP.md` §2.6). Es el cambio
   más grande y el único que altera el contrato del menú: va en su propio
   commit, con el system prompt actualizado en el mismo.
7. **Cortesías de dos palabras y emojis** ("ok gracias", "👍") reciben el menú
   entero porque la comparación es por igualdad exacta.
8. **Duplicados que ya divergen**: cuatro definiciones de "qué es moneda base",
   tres de símbolo de moneda, dos de redondeo (una sin epsilon), dos de los TTL
   del replay, y los límites de WhatsApp escritos a mano en el render en vez de
   usar la tabla que ya existe.
9. **Journals sin versión de formato.** Cambiar un campo del estado de emisión
   deja borradores viejos que se reanudan con campos vacíos.
10. **`no_network_call: true` después de mandar un WhatsApp**, y un puñado de
    campos que se devuelven sin declarar en el `outputSchema`.
11. **El plan de anulación** pide 181 días en una sola llamada, sin ventanear:
    cuando la API responda 500 el chequeo de doble acreditación no va a
    funcionar nunca, y hoy eso degrada en silencio a "asumo que no está anulado".
12. **El proceso necesita un token de Biller propio** aunque tenga veinte
    empresas: es una credencial de más que hay que custodiar y un directorio
    `_proceso` que no sirve para nada en multi-empresa.
