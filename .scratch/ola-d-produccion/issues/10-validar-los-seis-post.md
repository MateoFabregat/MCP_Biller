# 10 — Los seis POST que faltan validar en TEST

**Qué construir:** la verificación contra `test.biller.uy` de las escrituras que
todavía no se probaron nunca de verdad.

**Severidad:** alta · **Bloquea producción:** sí

## Estado

| Escritura | Verificada contra TEST |
|---|---|
| `biller_emitir_comprobante` | ✅ 03/09/2026 (201) y de nuevo en la demo |
| `biller_anular_comprobante` | ❌ |
| `biller_crear_cliente` | ❌ |
| `biller_cargar_producto` | ❌ |
| `biller_crear_recibo` | ❌ |
| `biller_cancelar_recibo` | ❌ |
| `biller_crear_pago` | ❌ |

## Por qué importa

Los schemas de los POST en el OpenAPI traen **ejemplos, no schemas estrictos**.
Ya pasó dos veces que la API real exige algo que la doc no dice
(`direccion`/`ciudad` obligatorias, 422 por `numero_interno` inexistente): ver
`docs/ARQUITECTURA.md` §7.

## Cómo hacerlo sin ensuciar

Cada una con dry-run primero, después `confirm: true`, y anotando el resultado
en `docs/ARQUITECTURA.md` §7 igual que las anteriores. El recibo y el pago se
prueban contra un comprobante emitido por la demo, que ya existe en TEST.
