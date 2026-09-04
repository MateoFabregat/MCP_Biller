# 02 — Actualizar la skill distribuida de Biller

**What to build:** lograr que un agente que cargue la skill de consultas use las capacidades y reglas actuales del servidor: períodos simbólicos resueltos en Uruguay, modo operativo real, anulación planificada y totales separados por moneda.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- La skill `biller-consultas` indica que la instalación siempre es de solo lectura.
- Ordena calcular fechas concretas en el modelo, aunque el servidor ya resuelve alias como `hoy` y `mes_actual` en hora uruguaya.
- Su tabla cubre solo una parte de las tools actuales y no explica correctamente el plan de anulación.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Los importes siempre provienen de tools y UYU/USD nunca se suman entre sí.
- `biller_plan_anulacion` puede usarse en lectura; la ejecución sigue dependiendo de las barreras de escritura.
- No cambiar schemas, handlers ni comportamiento de ninguna tool.
- No intentar enumerar ejemplos de todas las conversaciones posibles.

## Acceptance criteria

- [ ] La skill exige usar alias simbólicos de período cuando exista uno y deja la resolución del día al servidor.
- [ ] Explica la diferencia entre `read_only`, `write_enabled` y ejecución real habilitada.
- [ ] Describe el plan de anulación sin prometer que anular es una operación reversible o de lectura.
- [ ] Prohíbe sumar o comparar importes de monedas distintas sin conversión autoritativa.
- [ ] La tabla de intención cubre las capacidades vigentes más importantes sin afirmar un conteo manual.
- [ ] Un test contractual falla si reaparecen “esta instalación es de solo lectura” o el cálculo de fechas concretas.
- [ ] El test focal, `npm run typecheck` y `npm test` pasan.
