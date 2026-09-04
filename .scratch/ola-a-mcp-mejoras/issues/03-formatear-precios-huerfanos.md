# 03 — Formatear precios huérfanos en los avisos

**What to build:** cuando una venta contiene precios que no pudieron asociarse a una línea, el aviso debe mostrarlos con el mismo formato monetario uruguayo que el resto del flujo, para que el usuario pueda reconocerlos antes de decidir qué hacer.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidencia y punto de partida

- El aviso de `rellenarDesdePedido` concatena números con `join`, por lo que 6500 aparece como `6500`.
- Ya existen helpers canónicos de símbolo y formato usados en las preguntas y botones de emisión.

## Invariantes y no-objetivos

- No tocar ni incluir en el commit la investigación competitiva preexistente sin versionar.
- Cambiar solo la presentación del aviso: la lista de precios, el estado del borrador y el siguiente paso deben ser idénticos.
- Usar exactamente el resultado del helper existente; no cambiar el helper ni imponer un nuevo signo, separador o formato global.
- No agregar parsing de lenguaje libre.

## Acceptance criteria

- [ ] Un precio 6500 se muestra con el separador de miles producido por el helper canónico.
- [ ] Decimales, cero y negativos se muestran exactamente como los representa ese helper.
- [ ] La moneda visible coincide con la moneda efectiva del borrador; no se inventa una conversión.
- [ ] Los mismos precios siguen quedando pendientes y se abre el mismo ítem que antes.
- [ ] `npx vitest run tests/borradorEmision.test.ts tests/emisionGuiada.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
