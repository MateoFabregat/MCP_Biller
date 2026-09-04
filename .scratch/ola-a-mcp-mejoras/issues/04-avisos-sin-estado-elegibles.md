# 04 — Contar solo comprobantes elegibles en avisos sin estado

**What to build:** hacer que los avisos de cohortes y comparación indiquen cuántos comprobantes relevantes carecen de estado, sin incluir documentos que igualmente quedan excluidos por no tener total o moneda válidos.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- Los contadores `sinEstado` se incrementan antes de descartar comprobantes con total o moneda ausentes.
- El error es cosmético: los importes calculados actualmente son correctos y no deben cambiar.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- “Elegible” debe usar el mismo predicado y orden de filtros que el cálculo correspondiente; no duplicar una segunda definición.
- Ningún total, serie, variación, cohorte ni agrupación puede cambiar.
- No cambiar el criterio fiscal de estados aceptados.

## Acceptance criteria

- [ ] Un comprobante sin estado y sin total válido no incrementa el aviso.
- [ ] Un comprobante sin estado y sin moneda válida no incrementa el aviso.
- [ ] Un comprobante elegible sin estado sí incrementa el aviso.
- [ ] Fixtures de regresión prueban que todos los importes permanecen iguales antes y después.
- [ ] `npx vitest run tests/cohortes.test.ts tests/comparacion.test.ts tests/equivalenciaConsultas.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
