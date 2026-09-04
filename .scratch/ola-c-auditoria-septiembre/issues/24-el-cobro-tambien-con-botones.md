# 24 — Registrar un cobro se confirma con un botón, no con un "dale"

**What to build:** que la única fila visible del menú que mueve plata sin botón deje de moverla con un "dale" interpretado por el modelo.

**Blocked by:** 18, 19 (comparte el camino de confirmación).
**Status:** blocked
**Severidad:** ALTA · **Archivos:** `src/tools/write/crearRecibo.ts`, `src/kapso/render.ts`, `src/kapso/protocolo.ts`

## Evidencia

De las siete operaciones de escritura, **solo dos** —emitir y anular— mandan botones por WhatsApp. Registrar un cobro, cancelar un recibo, dar de alta un cliente, cargar un producto y registrar un pago confirman solo por JSON.

Para el cobro eso significa: el agente redacta "¿registro el cobro de $X de Pérez?", el usuario escribe "dale", el enrutador lo lee como afirmación, y **el agente decide** que ese sí aplica al token que tiene en contexto.

Toda la propiedad que sostiene el preview de emisión —el token va adentro del id del botón, atado al payload por hash, así que tocar ✅ es indistinguible de confirmar exactamente lo que se leyó— **no existe acá**. Y "Registrar un cobro" es una fila visible del menú, o sea de las que más se tocan.

## Qué hacer

Extender el mismo mecanismo del preview de emisión al recibo: un constructor de mensaje de confirmación con el detalle del cobro, el token adentro del id del botón, y un prefijo propio en el protocolo de ids.

## Invariantes

- El ciclo dry-run → token → confirm no cambia: lo que se agrega es el canal.
- El token sigue atado al payload por hash. Si el saldo cambió entre el preview y el toque, el token deja de valer, como ya pasa hoy.
- El mensaje dice **a quién** se le imputa el cobro y **sobre qué documentos**, con la misma regla del preview: si la imputación es estimada, se declara.

## Acceptance criteria

- [ ] El dry-run con confirmación por WhatsApp manda botones y el id lleva el token.
- [ ] Tocar el botón ejecuta exactamente el payload previsualizado.
- [ ] Un token vencido responde el mismo mensaje que en la emisión.
- [ ] `npm run typecheck` y `npm test` pasan.
