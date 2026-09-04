# 15 — La última red del preview se pasa por un carácter

**What to build:** que el recorte de emergencia mida lo que realmente va a escribir.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media · **Archivo:** `src/kapso/render.ts`

## Evidencia

El bucle mide con el placeholder `"… (N renglones del detalle no entraron)"` (39 caracteres) pero escribe `"… (1 renglón/es del detalle no entraron)"` (40). El cuerpo queda en 1025, el cliente recorta a 1023 + "…", y el mensaje termina en **`¿Lo emito…`**.

Reproducido en el escenario sin `max_chars`: `lo_emito: false`, cuerpo 1025.

Peor: el primer renglón que elimina es justo `"… 12 ítems más que no entran en el mensaje (el TOTAL sí los incluye)"`, o sea que reemplaza la declaración de los ítems ocultos por "1 renglón no entró".

Hoy el único llamador de producción pasa `max_chars`, así que la red solo se activa en el camino que dice cubrir — y ahí falla.

## Qué hacer

1. Calcular el aviso **real** dentro del bucle, con el número que va a llevar, y comparar contra ese largo.
2. Cuando el renglón elegido para eliminar es la línea de ítems ocultos (empieza con `"… "`), eliminar el anterior en su lugar: esa declaración es información, no relleno.

## Acceptance criteria

- [ ] Test: 20 ítems, razón social de 150 caracteres, un aviso crítico y uno ambiguo, **sin** pasar `max_chars` → el cuerpo entra en 1024, contiene "¿Lo emito?" y contiene "ítems más que no entran".
- [ ] `npx vitest run tests/regresionesAuditoria.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
