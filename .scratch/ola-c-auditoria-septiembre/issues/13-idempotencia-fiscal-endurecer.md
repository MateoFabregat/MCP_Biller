# 13 — Endurecer el registro fiscal de idempotencia (tres regresiones)

**What to build:** que la protección contra emitir dos veces el mismo CFE vuelva a ser tan fuerte como antes de los cambios de hoy, sin volver a dejar un `.lock` por comprobante para siempre.

**Blocked by:** None. **Es la issue de mayor riesgo de la tanda: acá se decide si un comprobante fiscal se puede emitir dos veces.**
**Status:** ready-for-agent
**Severidad:** ALTA ×3 · **Archivo:** `src/write/idempotency.ts`

## Contexto

Hoy se cambió este archivo: el `.lock` de una key se suelta al llegar a estado terminal (antes quedaba para siempre, uno por CFE emitido), `claim` RELEE el journal para compensarlo, y el journal se compacta pasadas las 1000 líneas. La auditoría encontró tres agujeros en ese cambio.

## R1 — La compactación corre en CADA escritura pasadas las 1000 keys

`lineasJournal = actual.estados.size` después de compactar, y las keys `executed` no se borran nunca. Con más de 1000 CFE el contador queda por encima del umbral **para siempre**: cada `markExecuted` reescribe el journal entero.

Reproducido: 1100 claim+markExecuted → 109 compactaciones; las 10 operaciones siguientes → 10 compactaciones más.

Mil CFE es "más de un mes" según el propio comentario del archivo. A partir de ahí el registro fiscal se reescribe en cada emisión, y cada reescritura abre la ventana de R2.

**Arreglo:** umbral relativo. Compactar cuando `lineasJournal > Math.max(UMBRAL_COMPACTACION, 2 * this.states.size)`. Así la compactación se dispara cuando el journal duplica al estado real, que es cuando sirve.

## R2 — La compactación de un proceso pierde el append de otro

`persistir` hace `openSync(path, "a")` y escribe. Si entre el open y el write otra instancia hizo `readFileSync` + `renameSync(tmp, path)`, el write cae en el inode viejo, ya desvinculado, y **desaparece del journal**.

Simulado de forma determinista: B abre el fd, A compacta, B escribe `executed` → el journal queda con `in_flight` y sin `executed`, y B —creyendo que persistió— borra su `.lock`. La key queda in_flight para siempre (falla cerrado, pero nadie la puede reintentar). Si se pierden las dos líneas de la misma operación, la key desaparece del journal con el lock ya borrado y **el CFE se puede emitir dos veces**.

**Arreglo:**
1. Un lock global `${path}.compact.lock` con `O_EXCL`. `compactarSiHaceFalta` lo toma antes de leer; si ya existe, **saltea** la compactación (otro proceso la está haciendo).
2. `persistir` toma el MISMO lock alrededor de open+write+close. Si no lo consigue tras unos reintentos cortos, devuelve `false` → falla cerrado, que es la política del archivo.
3. Soltar el lock en `finally`, siempre.
4. Después del `renameSync`, `fsync` del DIRECTORIO (abrirlo, `fsyncSync`, cerrarlo): sin eso, un corte de luz puede dejar el inode viejo sin los appends posteriores.

## R3 — Borrar el journal en caliente ahora permite reemitir

Antes, el `.lock` por key sobrevivía y frenaba el claim aunque el journal desapareciera. Ahora el journal es la ÚNICA memoria: un logrotate, un restore de un backup viejo o un `rm` accidental pasan de inocuos a **reemisión fiscal**.

Reproducido: key ejecutada → borrar el journal → una instancia nueva concede el claim.

**Arreglo:** un centinela. La primera vez que `persistir` crea el journal, crear también `${path}.creado` (vacío, 0600). En el constructor: si el centinela existe y el journal NO, marcar la carga como no confiable y degradar con un mensaje que diga exactamente qué pasó ("el journal desapareció y el centinela sigue ahí: alguien lo borró o lo rotó"). A partir de ahí el store niega claims nuevos hasta que un humano lo mire, que es el lado seguro.

## Invariantes

- **Fallar cerrado siempre.** Ante cualquier duda, el POST no se ejecuta.
- No volver a dejar locks eternos: eso es lo que este archivo acaba de arreglar.
- Los mensajes de error los lee un operador con una emisión trabada: tienen que decir qué pasó y qué mirar.

## Acceptance criteria

- [ ] Test: 1100 claim+markExecuted, contar compactaciones; 10 operaciones más → **cero** compactaciones nuevas.
- [ ] Test: con el lock de compactación tomado, `persistir` devuelve `false` y `markExecuted` **no** suelta el `.lock` de la key.
- [ ] Test: key ejecutada → borrar el journal → una instancia nueva **lanza** en `claim` (no concede).
- [ ] Los tres tests que ya existen en `tests/regresionesAuditoria.test.ts` bajo "registro fiscal de idempotencia" siguen pasando.
- [ ] `npm run typecheck` y `npm test` pasan.
