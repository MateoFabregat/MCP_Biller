# 23 — Un 429 se reintenta, y se respeta el Retry-After

**What to build:** que el único 4xx que es transitorio por definición se trate como transitorio.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media · **Archivos:** `src/biller/traerVentanas.ts`, `src/utils/errors.ts`, `src/biller/client.ts`

## Evidencia

El reintento acepta timeout, error de red y 5xx. El 429 queda afuera, y es el único 4xx que significa "volvé a intentar". El limitador de tasa local es **por proceso**: con dos instancias de la misma empresa, o con un integrador externo usando el mismo token, los 429 aparecen.

Una consulta de un año son 53 ventanas. Un 429 en la número 40 aborta todo con un mensaje que dice "esperá unos segundos" a un modelo que no puede esperar. El header `Retry-After` no se lee en ningún lado.

## Qué hacer

1. Tratar el 429 como transitorio en el reintento de GET.
2. Leer `Retry-After` de la respuesta (viene en segundos o como fecha) y guardarlo en el error.
3. Cuando está, esperar **el mayor** entre el backoff propio y lo que pidió el servidor.

## Invariantes

- **Solo en GET.** El POST no se reintenta nunca: un POST ambiguo se marca como tal y se bloquea. Esa regla no se toca.
- El backoff sigue teniendo tope: `Retry-After` no puede colgar la consulta indefinidamente.

## Acceptance criteria

- [ ] Test: un 429 con `Retry-After: 2` seguido de un 200 devuelve el resultado, y la espera fue de al menos 2 segundos.
- [ ] Test: el POST sigue sin reintentarse ante 429.
- [ ] `npm run typecheck` y `npm test` pasan.
