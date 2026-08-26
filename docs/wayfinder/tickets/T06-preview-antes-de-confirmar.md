# Qué tiene que decir el preview para que confirmar sea seguro

- **Estado:** abierto
- **Tipo:** prototype
- **Asignado:** —
- **Bloqueado por:** [Las reglas reales para que un 101 y un 111 salgan bien](T01-reglas-de-emision-validas.md)

## Question

El preview con botones ✅/✖️ es el último momento antes de que exista un
documento fiscal. ¿Qué tiene que mostrar para que tocar ✅ sea una decisión
informada y no un acto de fe?

Hoy muestra: tipo, subtotal, IVA, total, cliente. Eso alcanzaba cuando el flujo
tenía menos datos. Ahora hay más cosas que el usuario decidió y que puede haber
entendido mal — y el preview es el único lugar donde puede darse cuenta.

A definir:

1. **El IVA, con el precio bruto adentro.** Si dijo "500 con IVA incluido", el
   preview tiene que dejar ver que el neto es 409,84 y el IVA 90,16. Es el punto
   exacto donde se detecta el malentendido de `montos_brutos`.
2. **Moneda extranjera**: si factura en USD, ¿se muestra el equivalente en pesos
   y con qué cotización? Aprobar "USD 500" sin ver el peso es aprobar a medias.
3. **Cliente nuevo vs. existente**: si se está por dar de alta un cliente, ¿el
   preview lo dice? Es la última chance de frenar un alta con datos mal.
4. **Varios ítems**: ¿se listan todos o se resume? El cuerpo de un mensaje de
   WhatsApp tiene 1024 caracteres.
5. **Qué NO mostrar.** Un preview largo se deja de leer, y un preview que no se
   lee es peor que ninguno porque da la sensación de haber revisado.

## Cómo se resuelve

Con `/prototype`: escribir los mensajes reales, para tres o cuatro casos
distintos (mostrador simple, e-Factura con cliente nuevo, USD, varios ítems), y
mirarlos. No se decide en abstracto — se decide viendo el texto que le va a
llegar al teléfono.
