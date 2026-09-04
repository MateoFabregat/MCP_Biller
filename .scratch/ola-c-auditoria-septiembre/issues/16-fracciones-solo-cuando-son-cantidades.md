# 16 — Una barra no siempre es una fracción

**What to build:** que la lectura de fracciones no dependa de un espacio ni convierta códigos en cantidades.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media (fiscal: mueve la cantidad de una línea) · **Archivo:** `src/services/importe.ts`

## Evidencia

Hoy se agregó la lectura de fracciones con barra. Medido:

| Entrada | Antes | Ahora | Debería |
|---|---|---|---|
| `"1/2 kg"` | 1 | 0,5 ✅ | 0,5 |
| `"1/2kg"` (sin espacio) | 1 | **1** ❌ | 0,5 |
| `"12/03"` | 12 | **4** ❌ | rechazar |
| `"3/12"` | 3 | **0,25** ❌ | rechazar |
| `"art 12/24"` | 12 | **0,5** ❌ | rechazar |
| `"3 x 1/2"` | 3 | 0,5 ⚠️ | decidir |

Dos problemas distintos:
1. **El espacio decide el precio.** El mismo usuario factura distinto según si apretó la barra espaciadora. Es inaceptable en un número que va a un documento fiscal.
2. **Un código con barra se lee como división.** Un talle, un lote o una fecha corta se convierten en cantidad.

## Y el mismo bug del "0.500", pero con coma

El arreglo de hoy puso `[1-9]` en la rama del PUNTO y no se replicó en la rama de la COMA, que es el separador decimal uruguayo:

```
parsearCantidad("0,500") -> 500   (debería ser 0,5)
parsearCantidad("0,750") -> 750
parsearCantidad("0,250") -> 250
```

"0,500" no es ninguna forma de escribir quinientos. La regla de la coma de miles existe para el formato importado (`6,500`), y un grupo entero de un solo cero nunca es eso.

Peor: por el camino del extractor (`src/kapso/extraerPedido.ts`) la marca `ambiguo` **se descarta**, así que `"0,500 kg de queso a 600"` factura 500 kg sin una sola advertencia.

## Qué hacer

1. Aceptar la unidad pegada: el denominador puede terminar en letras (`"1/2kg"`).
2. **Rechazar como fracción** todo `num/den` con `num >= den`, salvo la forma mixta (`"2 1/2"`). Nadie pide "doce medios" de algo; sí pide medio, un cuarto, tres cuartos.
3. **Rechazar** los denominadores que no son de mostrador: aceptar solo 2, 3, 4, 5, 8 y 10.
4. Cuando se rechaza, el detalle tiene que preguntar en vez de adivinar: decir que puede ser un código y pedir la cantidad.
5. **La rama de la coma**: mismo criterio que la del punto. Un grupo entero que es un cero solo no es un separador de miles.
6. **El extractor deja de tragarse la ambigüedad**: si `parsearCantidad` devuelve `ambiguo`, marcarlo en el ítem y propagarlo, igual que ya se hace con el precio.

## Invariantes

- `"1/2 kg"` → 0,5 y `"2 1/2"` → 2,5 siguen funcionando.
- Todo lo que ya andaba sigue igual: `"3 unidades"`, `"media docena"`, `"1.000"`, `"0,500"` ambiguo, `"0.500"` → 0,5, `"10/10/2026"` → 10, `"-3"` y `"0"` → null.
- Ante la duda **no se elige**: es la doctrina del proyecto.

## Acceptance criteria

- [ ] Los seis casos de la tabla dan el valor de la columna "debería".
- [ ] `parsearCantidad("0,500")` da 0,5 **sin** ambigüedad; lo mismo `"0,750"` y `"0,250"`.
- [ ] `"6,500"` sigue leyéndose 6500 y sigue marcado como ambiguo (esa regla no cambia).
- [ ] `extraerPedidoEmision("0,500 kg de queso a 600")` da cantidad 0,5.
- [ ] Los invariantes de arriba siguen pasando.
- [ ] `npx vitest run tests/importe.test.ts tests/regresionesAuditoria.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
