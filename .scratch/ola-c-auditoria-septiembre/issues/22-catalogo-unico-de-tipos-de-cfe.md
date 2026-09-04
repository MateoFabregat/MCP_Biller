# 22 — Un solo catálogo de tipos de comprobante

**What to build:** que agregar o reclasificar un tipo de CFE se haga en un solo lugar.

**Blocked by:** None (pero conviene después de la ola de arreglos).
**Status:** ready-for-agent
**Severidad:** ALTA por consecuencia, baja por probabilidad · **Archivos:** `src/biller/cfeSchema.ts`, `src/services/cfeTypes.ts`, `src/biller/requisitos.ts`

## Evidencia

Hoy un tipo de comprobante vive en **cinco tablas repartidas en tres archivos**:

1. La lista que valida y da la etiqueta.
2. Las cuatro categorías que deciden el signo al sumar (venta, nota de crédito, nota de débito, especial).
3. Las dos familias que deciden si hace falta receptor identificado.
4. Los sets de exportación, remito, nota de ajuste y sin retenciones.

Las etiquetas **ya divergen** entre tablas ("Nota de crédito de e-Ticket" vs "Nota de Crédito de e-Ticket").

Modo de falla: DGI publica un tipo nuevo. Se agrega donde valida —porque si no, el comprobante se rechaza y eso se nota— y se olvida donde suma. El resumen lo excluye con un warning que el modelo no lee. O peor: se agrega como venta y era una nota de crédito, y **el total sube en vez de bajar**. Nada falla.

## Qué hacer

Una tabla única, con una entrada por tipo y todas sus propiedades: etiqueta, categoría, familia, y los cuatro flags. De ella se **derivan** las cinco listas que hoy se escriben a mano, conservando los nombres exportados para no tocar a ningún importador.

## Invariantes

- Los signos de suma no cambian: hay tests que los fijan y tienen que seguir verdes sin tocarlos.
- La etiqueta que se muestra queda la que hoy usa el resumen (la que ve el usuario), no la otra.

## Acceptance criteria

- [ ] Test nuevo: todo tipo válido está en **exactamente una** categoría.
- [ ] Test: las familias de e-Ticket y e-Factura son subconjunto de ventas + notas.
- [ ] Test: la etiqueta de la clasificación coincide con la de la lista de validación, para todos los tipos.
- [ ] Los tests de resumen y de anulación pasan **sin modificarse**.
- [ ] `npm run typecheck` y `npm test` pasan.
