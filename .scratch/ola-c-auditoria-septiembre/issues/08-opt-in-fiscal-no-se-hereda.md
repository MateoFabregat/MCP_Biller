# 08 — El opt-in de IVA estimado se decide por empresa

**What to build:** que `BILLER_ENABLE_IVA_ESTIMADO` no se herede del proceso a las veinte empresas.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja · **Archivo:** `src/tenants/registry.ts`

## Evidencia

`VARIABLES_QUE_NO_SE_HEREDAN` dice que entra "todo lo que gobierna una barrera", y esta variable quedó afuera. Prenderla en el proceso registra `biller_posicion_iva` para TODAS las empresas del registro. Es un opt-in de riesgo fiscal —una estimación de IVA se parece peligrosamente a una declaración—, no una preferencia técnica.

## Qué hacer

Agregar `"BILLER_ENABLE_IVA_ESTIMADO"` a `VARIABLES_QUE_NO_SE_HEREDAN`, con un comentario que diga que es un opt-in fiscal y se decide por empresa.

## Acceptance criteria

- [ ] Test en `tests/registry.test.ts`: proceso con la variable en `true` y un tenant que no la declara → `entornoDe(tenant).BILLER_ENABLE_IVA_ESTIMADO === undefined`.
- [ ] `npm run typecheck` y `npm test` pasan.
