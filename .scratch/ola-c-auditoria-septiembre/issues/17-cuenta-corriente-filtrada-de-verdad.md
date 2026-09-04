# 17 — Filtrar la cuenta corriente por cliente tiene que filtrar TODO

**What to build:** que preguntar por un cliente no devuelva los totales de toda la cartera.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** CRÍTICA (contesta una pregunta de plata con el número equivocado) · **Archivo:** `src/tools/cuentaCorriente.ts`

## Evidencia

El filtro por `cliente_rut` recorta `documentos` y `por_cliente`, pero publica **sin filtrar**: `saldo_por_moneda`, `vencido_por_moneda`, `por_vencer_por_moneda`, `saldo_a_favor_por_moneda`, `resumen_por_bucket`, `cobranzas` y `totales`.

Reproducido: cliente A debe 1.000, cliente B debe 5.000. Pidiendo solo A:

```
por_cliente: 1 fila (A, 1.000)
saldo_por_moneda.UYU.total: 6000   ← la cartera entera
```

"¿Cuánto me debe Pérez?" se contesta con la deuda de todos si el modelo lee el total en vez de la fila, que es lo que un total invita a hacer. Y la descripción del parámetro promete que "acota también los cobros". Lo mismo pasa con el filtro por `moneda`.

## Qué hacer

Cuando `cliente_rut` o `moneda` están puestos, **recalcular los agregados sobre lo filtrado**: sumar los saldos desde `por_cliente` ya filtrado, filtrar `cobranzas` por cliente, y recalcular `resumen_por_bucket` y `totales` desde los documentos filtrados.

Si por algún motivo un agregado no se puede recalcular, **ponerlo en `null` con un warning explícito** que diga que ese número es de toda la cartera. Un número que no corresponde a lo que se preguntó es peor que ningún número: esa es la doctrina del proyecto.

Corregir además el texto del parámetro para que diga la verdad.

## Acceptance criteria

- [ ] Test: dos clientes con deudas distintas; pidiendo uno, `saldo_por_moneda` es el de ese cliente.
- [ ] Test: el filtro por moneda tampoco arrastra las otras.
- [ ] Test: `cobranzas` solo trae las del cliente pedido.
- [ ] Sin filtro, todo sigue igual que hoy.
- [ ] `npx vitest run tests/cuentaCorriente.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
