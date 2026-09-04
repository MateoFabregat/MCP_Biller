# Ola D — De la demo a producción

Salió de tres cosas del 04/09/2026: el análisis de los diez negocios reales
(`docs/CASOS_REALES.md`), lo que quedó escrito y sin ejecutar de la ola C, y las
preguntas de infraestructura que el dueño puso sobre la mesa.

## Orden

Por lo que cuesta si NO se hace, no por tamaño.

| # | Ticket | Tipo | Bloquea producción |
|---|---|---|---|
| 01 | Pedirle a Biller un endpoint de validación (dry-run) | producto | no, pero es el de mayor palanca |
| 02 | Verificar cómo llega un audio transcripto | verificación | sí (define si el mostrador puede dictar) |
| 03 | Exportación: el indicador de facturación | decisión del dueño | sí, para ese caso |
| 04 | Cuenta corriente con fecha de corte | feature | no |
| 05 | Reintentar el 429 de Biller | robustez | sí |
| 06 | Todo submenú con salida de un toque | UX | sí |
| 07 | Catálogo único de tipos de CFE | deuda | no |
| 08 | El cobro también con botones | UX | no |
| 09 | Infraestructura: dominio, secretos, backup, monitoreo | infra | sí |
| 10 | Los seis POST que faltan validar en TEST | verificación | sí |

## Lo que NO está acá, y por qué

- **Productos como botones:** descartado con medición. Ver ADR-002.
- **Store compartido (Redis/Postgres):** tiene fecha de vencimiento, no urgencia.
  Ver ADR-003.
