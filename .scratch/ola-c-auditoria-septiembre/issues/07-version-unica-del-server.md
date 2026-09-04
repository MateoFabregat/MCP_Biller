# 07 — Una sola versión del server, verificada por un test

**What to build:** que la versión que el server anuncia sea la que se publica.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja · **Archivos:** `src/constants.ts`, `tests/conteosDoc.test.ts`

## Evidencia

`src/constants.ts` dice `0.1.0`; `package.json` dice `0.1.1`; `src/cli/init.ts` referencia `@0.1.1`. El `initialize` de MCP y `biller_health_check` anuncian una versión que no es la publicada, y ningún test lo compara.

## Qué hacer

1. `src/constants.ts`: `SERVER_VERSION = "0.1.1"`.
2. `tests/conteosDoc.test.ts`: agregar un caso que lea `package.json` y afirme `SERVER_VERSION === pkg.version`, y que la referencia de `src/cli/init.ts` termine en esa versión.

## Acceptance criteria

- [ ] El test falla si alguien sube la versión en `package.json` y se olvida de `constants.ts`.
- [ ] `npm run typecheck` y `npm test` pasan.
