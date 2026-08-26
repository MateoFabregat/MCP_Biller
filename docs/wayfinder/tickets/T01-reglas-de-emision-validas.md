# Las reglas reales para que un 101 y un 111 salgan bien

- **Estado:** abierto
- **Tipo:** research
- **Asignado:** —
- **Bloqueado por:** —

## Question

¿Cuál es el conjunto EXACTO de campos y reglas que hacen que un e-Ticket (101) y
una e-Factura (111) se emitan correctamente — no solo que devuelvan 201?

Hay que separar tres cosas que hoy están mezcladas: lo que el OpenAPI declara
obligatorio, lo que la API **realmente** rechaza, y lo que acepta pero produce un
comprobante equivocado. La tercera es la peligrosa: devuelve 201 y el error se
descubre cuando el cliente reclama.

Un caso ya confirmado de la tercera clase: `montos_brutos`. En la prueba del
28/07 se cargó un precio de 500 y el comprobante salió en 610, porque el sistema
asumió que el precio era sin IVA. Nadie se enteró hasta mirar el PDF.

Preguntas concretas a cerrar, cada una **verificada contra `test.biller.uy`**:

1. `montos_brutos`: ¿qué cambia exactamente en el total y en el IVA
   discriminado? ¿Se puede mezclar con `descuento_tipo` sin sorpresas?
2. Consumidor final **sin identificar**: ¿el objeto `cliente` se omite, va
   vacío, o lleva algo? La doc dice que `cliente.sucursal.pais` es "el único
   campo obligatorio para clientes que no son empresas" — ¿aplica cuando no hay
   cliente?
3. `tasa_cambio` omitida: ¿qué cotización toma y cómo se ve en la respuesta?
4. `numero_interno`: ¿la API lo valida como único, o solo lo guarda? ¿Qué
   devuelve exactamente ante un duplicado?
5. `fecha_emision` con la fecha de hoy: ¿hay zona horaria de por medio?
6. El umbral de 5.000 UI: ¿lo valida Biller, o es responsabilidad nuestra?
7. `indicador_facturacion` por ítem vs. comprobante: ¿se pueden mezclar tasas
   distintas en un mismo CFE?

## Entregable

Un documento de referencia (linkeado acá) con la matriz campo por campo:
obligatorio / opcional / "acepta pero sale mal", con la evidencia de la llamada
real que lo demuestra. Es la base de los tickets de flujo y de preview.
