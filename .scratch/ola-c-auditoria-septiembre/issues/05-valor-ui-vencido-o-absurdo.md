# 05 — El valor de la UI puede estar vencido o ser un tipeo, y nadie lo dice

**What to build:** detectar y avisar cuando el valor de la Unidad Indexada configurado está fuera de rango plausible, mal escrito o vencido.

**Blocked by:** None.
**Status:** hecha ✅ (04/09/2026)
**Severidad:** ALTA (puede producir un CFE mal emitido) · **Archivos:** `src/config.ts`, `src/biller/requisitos.ts`, `src/tools/health.ts`

> Nota de proceso: este archivo se perdió al crearse la tanda (un `cd` que falló
> se comió el heredoc) y el ejecutor lo reconstruyó a partir del README de la ola
> y de `docs/VARIABLES.md`. Se escribe ahora con lo que efectivamente se hizo.

## Evidencia

El umbral que decide si un e-Ticket exige receptor identificado es
`5.000 UI × valor_ui`. Antes de este cambio:

- `BILLER_VALOR_UI` se parseaba con el parser tolerante: un valor basura volvía
  `undefined` **en silencio** y caía al de referencia.
- `BILLER_VALOR_UI_FECHA` **no se validaba** como fecha ni se miraba su
  antigüedad. Nada la usaba salvo imprimirla.
- `biller_health_check` no mostraba ni el valor ni la fecha: no había dónde verlo.

El fallback está sesgado a la baja **a propósito**: avisa de más. **El valor
configurado no tenía ningún sesgo ni ningún techo.** Un tipeo de `65` en vez de
`6.5` pone el umbral en $325.000, y un e-Ticket de $80.000 sale sin receptor.
Eso es un CFE mal emitido, que se corrige con otro documento ante DGI.

La UI sube con la inflación todos los días: un valor de hace un año siempre está
viejo.

## Qué se hizo

1. **Tres validaciones** en la resolución del umbral, cada una con su propio
   motivo declarado: formato de la fecha, plausibilidad del valor (banda de $1 a
   $20, que atrapa el punto decimal corrido) y **antigüedad mayor a 15 días**.
   Cualquiera de las tres degrada al valor de referencia y lo dice, tanto en la
   nota como en un campo nuevo.
2. La fecha de hoy entra **por parámetro** desde los tres llamadores, y sale de
   `services/fechaUy.ts`. Nunca `new Date()`: hay un test estático que lo vigila.
3. La configuración ahora **avisa** cuando el valor ni siquiera parsea como
   número, y descarta la fecha si no tiene formato.
4. `biller_health_check` corre la resolución sobre la configuración vigente y
   avisa si el valor configurado **no se está usando**. Y el indicador de
   "producción lista" pasó de mirar presencia a mirar vigencia real.

## Invariantes respetados

- **No se rompe el arranque** por un valor de UI malo: se degrada con aviso.
- No se tocó el valor de referencia: está bajo a propósito.
- La antigüedad se calcula contra el día uruguayo.
