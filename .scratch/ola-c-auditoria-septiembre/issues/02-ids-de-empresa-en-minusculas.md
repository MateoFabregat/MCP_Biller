# 02 — El id de empresa se exige en minúsculas y acotado

**What to build:** impedir que dos empresas con ids que difieren solo en mayúsculas compartan los mismos archivos en disco.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media (alta en macOS/Windows/Docker Desktop) · **Archivo:** `src/tenants/registry.ts`

## Evidencia

`construirRegistro` acepta `[A-Za-z0-9-]` y deduplica byte a byte, pero las cinco rutas de persistencia se derivan como `<data_dir>/<id>/…`. En un filesystem case-insensitive, `Panaderia` y `panaderia` son **el mismo directorio**.

Reproducido en este Mac: el registro aceptó las dos, `audit.jsonl` resultó el mismo inode, y la empresa B leyó una línea fiscal de la A. El `empresa=` de métricas ya lowercasea, así que las dos se fusionan en una etiqueta.

El comentario de `registry.ts` afirma hoy que compartir archivo "pasa de detectable a imposible: el id es único por construcción". Con mayúsculas, es falso.

## Qué hacer

1. Regex del id: `/^[a-z0-9-]{1,48}$/`.
2. Mensaje de error explicando **por qué**: el id es un componente de ruta, macOS y Windows no distinguen `Panaderia` de `panaderia`, y 48 es el largo que aceptan las etiquetas de métricas.
3. Actualizar el comentario del charset y el de `TENANT_IMPLICITO` en `src/config.ts`.
4. Actualizar `.env.example` (sección de tenants) y `docs/HANDBOOK.md` §6 para decir "minúsculas".

## Invariantes

- `slug()` de `scripts/onboard.mjs` ya lowercasea: el camino normal no cambia.
- Ningún fixture de tests usa mayúsculas (verificado).

## Acceptance criteria

- [ ] `construirRegistro` con id `Panaderia` lanza `TenantConfigError` y el mensaje contiene "minúsculas".
- [ ] Un id de 49 caracteres lanza.
- [ ] `panaderia-rivera` sigue pasando.
- [ ] `npx vitest run tests/tenants.test.ts tests/recargaTenants.test.ts tests/httpTransport.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
