# 12 — Tope al largo del texto que entra al enrutador

**What to build:** que el techo del texto entrante lo ponga el server y no Meta.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja · **Archivo:** `src/kapso/webhook.ts`

## Evidencia

`normalizarEvento` copia `text.body` sin cap (hasta 1 MB por el tope de cuerpo) y se lo pasa a `interpretarMensaje`, que es **síncrono**. Medido:

| Largo | Tiempo bloqueando el event loop |
|---|---|
| 4.096 chars | 28 ms |
| 64 KB | 359 ms |
| 1 MB | **5.780 ms** |

Durante esos segundos nadie más es atendido. Exige firma válida y remitente autorizado, y WhatsApp real corta en 4096 — por eso es baja. Pero hoy el techo lo pone Meta, no nosotros.

## Qué hacer

`export const MAX_TEXTO_ENTRANTE = 4096` (el tope real de un mensaje de WhatsApp) y recortar ahí el texto del evento. Aplicar lo mismo a los ids de botón y de fila con sus límites propios.

## Acceptance criteria

- [ ] Test: `normalizarEvento` con un `text.body` de 100.000 caracteres deja `texto.length === 4096`.
- [ ] Un mensaje normal no cambia en nada.
- [ ] `npx vitest run tests/webhook.test.ts tests/kapso.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
