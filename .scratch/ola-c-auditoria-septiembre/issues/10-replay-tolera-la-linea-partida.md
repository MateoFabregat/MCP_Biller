# 10 — Una línea partida en el journal de replay no puede dejar el webhook mudo

**What to build:** distinguir un archivo truncado por un crash de un archivo corrupto.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media (disponibilidad) · **Archivo:** `src/kapso/webhookReplay.ts`

## Evidencia

`cargar` marca `cargaConfiable = false` ante **cualquier** línea que no parsea, y `claim` lanza si la carga no es confiable → el transporte responde 503. Un kill en medio de un append deja media línea, y en el próximo arranque **todos** los webhooks de esa empresa dan 503. Meta reintenta y termina desactivando la suscripción. No se autorrecupera: la compactación no corre degradado.

Reproducido: journal con una línea válida y `{"digest":"bb` al final → `claim` lanza, y el segundo también.

`BorradorStoreArchivo.aplicarLineas` ya tolera la línea partida. Este store no.

## Qué hacer

1. En `cargar` y en `leerActual`: tratar distinto **la última porción** cuando el archivo no termina en `\n`. Si esa cola no parsea, ignorarla con `logger.warn("kapso.webhook.replay.linea_partida")` y **conservar** `cargaConfiable = true`.
2. Cualquier otra línea corrupta —en el medio— sigue degradando como hoy: eso sí es corrupción, no truncamiento.
3. Cuando hubo cola partida y la carga quedó confiable, forzar la compactación para que el archivo quede sano.

## Invariantes

- Fallar cerrado sigue siendo la regla ante corrupción real.
- No cambiar el formato del journal.

## Acceptance criteria

- [ ] Test: una línea válida + una cola partida al final → `claim` funciona y el estado de la línea válida se conserva.
- [ ] Test: basura en la PRIMERA línea → `claim` sigue lanzando.
- [ ] `npx vitest run tests/webhookReplay.test.ts tests/kapso.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
