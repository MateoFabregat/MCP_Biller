# 04 — Apretar permisos también cuando el archivo ya existía

**What to build:** que los archivos con datos comerciales queden 0600 y sus directorios 0700 aunque los haya creado otro.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja · **Archivos:** `src/write/audit.ts`, `src/kapso/borradorStore.ts`, `scripts/onboard.mjs`

## Evidencia

El `mode` de `appendFileSync`/`writeFileSync` solo aplica **al crear**. Medido con archivos preexistentes creados con umask 022:

```
audit preexistente tras record:       644 (esperado 600)
borradores preexistente tras guardar: 644 (esperado 600)
```

El borrador es lo más sensible que hay en disco: concepto, cliente, RUT y adenda. `write/idempotency.ts` y `kapso/webhookReplay.ts` ya hacen `chmodSync` después de escribir; estos tres no.

Caso real: el operador rota el audit con `cp`, o crea el directorio a mano antes de arrancar.

## Qué hacer

1. `src/write/audit.ts`, `Auditor.record`: `chmodSync(this.filePath, 0o600)` tras el append, dentro del mismo `try`.
2. `src/kapso/borradorStore.ts`, `BorradorStoreArchivo.escribir`: `chmodSync(this.path, 0o600)` tras el append. **No** tocar el modo del directorio: puede ser del operador.
3. `scripts/onboard.mjs`: `chmodSync(rutaRegistro, 0o600)` tras escribir el registro (tiene todos los tokens de Biller).

## Invariantes

- No cambiar el modo de `BILLER_DATA_DIR` (es del operador). Sí el de los directorios derivados.
- Un `chmod` que falla no puede tumbar la escritura: va en el mismo `try` que ya degrada.

## Acceptance criteria

- [ ] Un caso por archivo en `tests/audit.test.ts` y `tests/borradorStore.test.ts`, con `it.skipIf(process.platform === "win32")`: crear el archivo con 0644, ejecutar la operación, esperar `mode & 0o777 === 0o600`.
- [ ] `npm run typecheck` y `npm test` pasan.
