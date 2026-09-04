# 09 — Una llamada tardía no resucita un borrador que el usuario canceló

**What to build:** que la fusión por revisión distinga "otra llamada escribió" de "el usuario descartó esto".

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** media · **Archivo:** `src/kapso/borradorStore.ts`

## Evidencia

La fusión agregada hoy compara `previo.revision` contra `desdeRevision`. Pero `borrar` no deja rastro de la revisión que había, y `guardar` reinicia la numeración en 1. Escenario real:

1. La llamada A lee el borrador (revisión 1: Cliente X, 2 ítems) y se va a esperar la API.
2. El usuario toca ✖️ Cancelar (o manda `reiniciar=true`) y arranca de nuevo con Cliente Y. Eso vuelve a dejar la revisión en 1.
3. A vuelve y guarda con `desdeRevision: 1`. Las revisiones coinciden, así que el store **no ve que hubo un borrado en el medio**.

Reproducido: el estado final vuelve a ser Cliente X con sus dos ítems. **La factura que el usuario canceló reaparece a un toque de ✅ Emitir.**

Honestidad sobre el alcance: antes del cambio de hoy el resultado era el mismo (por pisado). El cambio no lo abrió, pero ahora el código documenta lo contrario ("gana el valor más nuevo") y la lápida se escribe siempre.

## Qué hacer

En `BorradorStoreMemoria`:

1. `private readonly lapidas = new Map<string, number>()` (sesión interna → revisión que tenía al borrarse).
2. En `borrar`, antes del `delete`: guardar la revisión del previo en `lapidas`.
3. Revisión **monotónica**: en `guardar`, `revision: (previo?.revision ?? this.lapidas.get(sesion) ?? 0) + 1`, y borrar la lápida al guardar.
4. Detectar la escritura tardía: si `desdeRevision > 0` y (no hay previo **o** la lápida es `>= desdeRevision`), la base que leyó quien llama fue descartada. **No guardar**: loguear `borrador.escritura_tardia_descartada` y devolver el estado actual.
5. En `BorradorStoreArchivo.aplicarLineas`, al aplicar `borrado: true`, registrar la lápida, para que funcione también entre instancias.
6. Corregir el comentario de `guardar`: la base descartada pierde, no gana el último.

## Invariantes

- La fusión concurrente **sin** borrado en el medio tiene que seguir funcionando: es lo que el cambio de hoy vino a arreglar.
- Un `borrar` de una sesión que no existe sigue escribiendo lápida.

## Acceptance criteria

- [ ] Test: guardar X → leer (rev 1) → `borrar` → guardar Y con `desdeRevision: 0` → guardar X' con `desdeRevision: 1` → el estado final es **Y**, sin los ítems de X.
- [ ] Test: dos escrituras concurrentes sin borrado en el medio siguen fusionando los dos aportes.
- [ ] `npx vitest run tests/borradorStore.test.ts tests/emisionGuiada.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
