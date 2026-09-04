# 08 — El cobro también con botones

**Qué construir:** que registrar un cobro se confirme tocando, como la emisión.
Viene escrito de la ola C y quedó sin ejecutar.

**Severidad:** baja · **Bloquea producción:** no

## El problema

`biller_recordatorio_cobro` y el registro de un cobro se confirman con un "sí"
ESCRITO, mientras que emitir y anular se confirman con botones que llevan el
token adentro. Es una asimetría rara: el usuario aprende a tocar para lo grande
y a escribir para lo chico.

## Qué mirar antes

El token de aprobación tiene que viajar en el id del botón, igual que en
`emitir:si:<token>`. Ver `kapso/protocolo.ts`.
