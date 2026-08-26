# El valor de la UI: cargarlo, y saber cuándo quedó viejo

- **Estado:** abierto
- **Tipo:** task
- **Asignado:** —
- **Bloqueado por:** —

## Question

El umbral que decide si hay que identificar al receptor de un e-Ticket son
5.000 UI. Hoy `BILLER_VALOR_UI` **no está seteado**, así que ese umbral no se
puede evaluar de verdad: el flujo cree que chequea una regla que en realidad no
está chequeando.

El valor cambia el **1° de enero** de cada año. Eso lo hace fácil de cargar y
fácil de olvidar: un valor del año pasado sigue pareciendo válido y produce
decisiones equivocadas en silencio durante doce meses.

A resolver:

1. Cargar el valor vigente y dejarlo documentado con su fecha.
2. **Detectar que está vencido** — si `BILLER_VALOR_UI_FECHA` es de un año
   anterior al actual, el sistema tiene que decirlo, no seguir como si nada.
3. Definir qué pasa cuando falta o está vencido: ¿se bloquea la emisión de
   e-Tickets grandes, o se emite avisando? El default silencioso de hoy es la
   peor de las dos.
4. Que `biller_health_check` lo reporte, igual que reporta el resto de la
   configuración.

## Nota

Es un ticket chico y sin dependencias, pero desbloquea la parte del flujo de
emisión que decide si pedir o no el documento del cliente. Mientras esté sin
resolver, esa decisión se toma con datos que no existen.
