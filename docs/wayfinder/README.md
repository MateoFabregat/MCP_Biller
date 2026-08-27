# Cómo funciona este tracker

No hay un issue tracker configurado para este repo, así que el mapa vive acá,
en markdown, que es el default de `/wayfinder`. Nada se publica afuera.

## Piezas

| | Dónde |
|---|---|
| El mapa | [`MAPA.md`](MAPA.md) — etiqueta `wayfinder:map` |
| Los tickets | `tickets/T##-<slug>.md` — hijos del mapa |

## Convenciones

Cada ticket abre con un bloque de metadatos:

```markdown
- **Estado:** abierto | cerrado
- **Tipo:** research | prototype | grilling | task
- **Asignado:** — | <quién lo está trabajando>
- **Bloqueado por:** — | [Nombre del ticket](T0X-slug.md)
```

- **Reclamar** un ticket = poner tu nombre en `Asignado` **antes** de empezar.
  Un ticket abierto y sin asignar está libre; uno asignado, no se toca.
- **Bloqueo**: markdown no tiene dependencias nativas, así que se declara en
  `Bloqueado por`. Un ticket está desbloqueado cuando todos los que lo bloquean
  están cerrados.
- **La frontera** = tickets abiertos, desbloqueados y sin asignar. Es lo que se
  puede agarrar ahora.
- **Cerrar** = `Estado: cerrado` + la respuesta en `## Resolución` + una línea
  en `Decisiones hasta ahora` del mapa.

## Reglas que no son negociables

1. **Una sesión resuelve UN ticket.** No dos.
2. **El mapa es un índice, no un depósito.** La decisión vive en su ticket; el
   mapa la resume en una línea y linkea.
3. **No cartografiar la niebla.** Si la pregunta todavía no se puede formular
   con precisión, va a `No especificado todavía`, no a un ticket.
