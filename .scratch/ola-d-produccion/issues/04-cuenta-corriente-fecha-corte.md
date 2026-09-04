# 04 — Cuenta corriente con fecha de corte

**Qué construir:** que "¿cuánto me debían al 30 de junio?" se pueda contestar.

**Severidad:** media · **Bloquea producción:** no

## El problema

`biller_cuenta_corriente` contesta el saldo de HOY. La pregunta de todo cierre
de mes —y la que hace el contador— es a una fecha: "¿cuánto me debían al 30/06?".

## Qué implica

El saldo a una fecha es: los comprobantes emitidos hasta esa fecha, menos los
cobros registrados hasta esa fecha. Los dos datos ya se traen; lo que falta es
el corte y, sobre todo, **no mezclar**: un cobro de julio no puede descontar de
un saldo al 30 de junio.

## Cuidado con

- La fecha de corte es por **fecha de emisión** (la fiscal), no por fecha de
  creación en la API. Ya hay un filtro local para esto y su warning.
- Los estados: la misma regla de `estaAceptado` que el resto de los totales.
- El aviso tiene que decir a qué fecha está calculado, en el mismo mensaje.
