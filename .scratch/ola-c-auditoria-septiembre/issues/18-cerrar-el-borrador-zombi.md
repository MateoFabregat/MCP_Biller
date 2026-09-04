# 18 — "Pará" y "cancelá" escritos cierran la factura

**What to build:** que una cancelación escrita cierre el borrador, y que el flujo deje de perseguir al usuario durante 24 horas.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** ALTA (experiencia; es el callejón sistémico del canal) · **Archivos:** `src/tools/menuWhatsapp.ts`, `src/kapso/webhook.ts`, `src/kapso/intenciones.ts`, `src/kapso/enrutador.ts`

## Evidencia

Solo el botón ✖️ borra el borrador. Reproducido: cargar hasta el paso del precio y escribir "pará" → la vía es `cancelacion`, pero `borrador_descartado: false` y `en_flujo: true`. Escribir "menú" → aparece el menú, y el borrador **sigue vivo**. Después, cualquier mensaje no catalogado —"che te hice una pregunta"— cae en la emisión guiada y contesta **"¿A qué precio por unidad? Solo el número."**

El razonamiento que dejó esto así es correcto para *"pará, eran 3 no 2"* (eso es una corrección) y falso para *"pará"* a secas, que es lo único que la lista de cancelaciones matchea por igualdad exacta.

Y en modo autónomo es peor: como el webhook deriva "hay flujo abierto" del store, un mensaje desconocido deja de autoresponderse el menú y se **delega** a un agente que no lo va a contestar bien.

## Qué hacer

1. **Cancelación pura con borrador vivo → borrar.** En el bloque que hoy solo mira el botón, agregar el caso de la vía `cancelacion` cuando hay flujo abierto. Poner `en_flujo` en falso.
   Texto exacto para el usuario:
   `Listo, dejé la factura sin hacer y no emití nada. Si querés arrancar otra, tocá "Emitir un comprobante" o escribime "menú".`
2. **Que el webhook pueda contestarlo solo.** Hoy la cancelación se delega siempre. Cuando hay flujo abierto, tiene que ser autorespondible: contestar ese texto y borrar. **Fuera de flujo se sigue delegando**, porque el agente puede tener otra confirmación pendiente (un recibo, por ejemplo) y no somos quiénes para cancelarla.
3. **Sinónimos que faltan:** "dejá", "dejá eso", "olvidalo". Hoy "dejalo" cancela y "dejá" no, y la propia descripción de `reiniciar` cita *"no, dejá"* como ejemplo.
4. **"menú" con borrador vivo** contesta el menú **más** una línea adelante:
   `Tenés una factura a medio cargar. Si la querés seguir, contestame lo que te pregunté; si no, escribí "cancelar" y la dejo sin hacer. Mientras tanto, acá van las opciones:`

## Invariantes

- **"pará, eran 3 no 2" sigue siendo una corrección** y NO borra nada. Es la frase que motivó el diseño actual.
- No cambiar el orden de los pasos del enrutador: ese orden es el invariante de ese módulo.
- Los textos le hablan al usuario final, sin jerga ni nombres de variables.

## Acceptance criteria

- [ ] Cargar hasta el precio, escribir "pará" → borrador descartado y flujo cerrado; el mensaje siguiente ya **no** cae en la emisión.
- [ ] "pará, eran 3 no 2" en flujo sigue siendo corrección y **no** borra.
- [ ] La decisión del webhook con borrador vivo y "cancelá" contesta y borra.
- [ ] "menú" en flujo menciona la factura a medio cargar.
- [ ] `npm run evals` sigue en 44/44 o más.
- [ ] `npm run typecheck` y `npm test` pasan.
