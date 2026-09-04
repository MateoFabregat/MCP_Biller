# 01 — El logger acumula secretos, no los reemplaza

**What to build:** que la redacción de secretos en los logs cubra a TODAS las empresas del proceso a la vez, y no solo a la última que cargó configuración.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media · **Archivos:** `src/logger.ts`, `src/tenants/registry.ts`

## Evidencia

`registrarSecretosParaLogs` hace `secretos = valores.filter(...)`: REEMPLAZA la lista. `loadConfig` corre una vez por empresa (`src/index.ts` al abrir sesión, `src/tools/register.ts` al construir el contexto, `src/transport/serverless.ts` en CADA request), así que el token de la empresa A deja de estar protegido en cuanto la B carga la suya.

Reproducido: cargando proceso → A → B y emitiendo `logger.error("http.request.error", { message: "…<tokenA>…" })`, el token de A sale EN CLARO después de que B carga.

Además, los `auth_token` de los tenants (el bearer que separa una contabilidad de otra) no se registran nunca.

## Qué hacer

1. `src/logger.ts`: `let secretos: string[]` pasa a `const secretos = new Set<string>()`. `registrarSecretosParaLogs` hace `for (const v of valores) if (typeof v === "string" && v.length >= 8) secretos.add(v)`. `redactar` itera el Set. Agregar `export function olvidarSecretosParaLogs(): void { secretos.clear(); }` **solo para tests**.
2. Actualizar el comentario del encabezado: los secretos se ACUMULAN; en multi-empresa hay uno por tenant y todos siguen vivos mientras viva el proceso.
3. `src/tenants/registry.ts`, al final de `construirRegistro` y antes del `return`: registrar los secretos de TODOS los tenants (`auth_token`, `BILLER_API_TOKEN`, `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET`, `BILLER_APPROVAL_SECRET`). Así quedan cubiertos aunque esa empresa nunca abra sesión.

## Invariantes

- No cambiar el formato de la línea de log ni el orden de las claves.
- La redacción sigue siendo sobre el JSON ya serializado.
- Nada de esto puede lanzar: un secreto `undefined` se ignora.

## Acceptance criteria

- [ ] Test nuevo `tests/loggerMultiEmpresa.test.ts`: espiar `process.stderr.write`, cargar dos configuraciones con tokens distintos, emitir una línea con los dos tokens y el `auth_token` de A, y verificar que ninguno aparece y que hay tres `[REDACTED]`.
- [ ] Segundo caso: `construirRegistro` con dos tenants redacta sus `auth_token` sin haber llamado a `loadConfig`.
- [ ] `npx vitest run tests/loggerMultiEmpresa.test.ts tests/config.test.ts tests/tenants.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
