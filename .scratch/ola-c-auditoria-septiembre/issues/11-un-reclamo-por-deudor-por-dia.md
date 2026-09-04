# 11 — "Uno por cliente por día" también entre el dueño y el contador

**What to build:** que la ventana de día del recordatorio de cobro no dependa de quién lo pidió.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja (negocio) · **Archivos:** `src/kapso/idempotency.ts`, `docs/KAPSO.md`

## Evidencia

El material de la clave incluye `actor: input.actorIdentity`. El dueño y el contador —los dos en la allowlist— producen claves distintas para el mismo deudor el mismo día, así que el cliente recibe **dos** reclamos. Es exactamente lo que la tool promete que no pasa.

Reproducido: `clave dia dueño == contador ? false`.

## Qué hacer

En la rama `dia` de `clavesSalidaKapso`, neutralizar también el actor: la identidad del envío pasa a ser empresa + destinatario + operación + sujeto + día. Dejar escrito en el comentario que el reenvío deliberado sigue teniendo su propia operación (`recordatorio_reenvio`), que es la vía explícita para mandar un segundo.

Actualizar `docs/KAPSO.md` §"Qué identifica al envío dentro de la ventana": hoy dice "destinatario, la operación y el sujeto" y omite que el actor estaba adentro.

## Acceptance criteria

- [ ] Test: dos claves con mismo tenant/destinatario/sujeto/día y `actorIdentity` distintos son **iguales**.
- [ ] Con `sujeto` distinto siguen siendo distintas.
- [ ] Las ventanas de reintento (15 min) **no** cambian: ahí el actor sigue contando.
- [ ] `npx vitest run tests/kapsoIdempotencia.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
