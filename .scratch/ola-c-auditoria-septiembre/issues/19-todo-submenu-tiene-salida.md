# 19 — Todo submenú de la emisión tiene una salida de un toque

**What to build:** un botón de cancelar en cada submenú del flujo de emisión.

**Blocked by:** 18 (comparte el camino de cancelación).
**Status:** blocked
**Severidad:** ALTA (experiencia) · **Archivos:** `src/kapso/render.ts`, `src/kapso/emision.ts`, `src/tools/emisionGuiada.ts`

## Evidencia

Ocho submenús del flujo de emisión, **ninguno** con salida tocable. El invariante escrito del proyecto dice que todo estado necesita una salida de un toque; hoy la salida es escribir "cancelá", que además cae en el callejón de la issue 18.

Seis de los ocho tienen lugar para un tercer botón (WhatsApp permite tres).

## Qué hacer

1. Agregar `✖️ Cancelar` como **último** botón en los seis submenús que tienen lugar. Los dos que ya usan los tres botones (receptor e IVA fusionado) resuelven con el **pie** del mensaje, que es texto corto: decir ahí que se puede escribir "cancelar".
2. El id nuevo se interpreta como una cancelación del flujo: borra el borrador y devuelve un paso `cancelado`.
3. Texto al cancelar:
   `Listo, dejé la factura sin hacer y no emití nada. Cuando quieras, arrancamos otra.`
   Y la instrucción al agente tiene que decirle explícitamente que **no reabra** la emisión ni mande el menú.

## Invariantes

- Ningún mensaje puede pasarse de 3 botones ni de 20 caracteres por botón: el validador local ya lo frena, y **falla en vez de truncar** a propósito.
- El pie de WhatsApp tiene 60 caracteres.

## Acceptance criteria

- [ ] Los ocho constructores pasan el validador de mensajes interactivos.
- [ ] Tocar el botón nuevo en cualquier paso borra el borrador y la llamada siguiente arranca de cero.
- [ ] El test de las 64 combinaciones de la emisión sigue verde.
- [ ] `npm run evals` en 44/44 o más.
