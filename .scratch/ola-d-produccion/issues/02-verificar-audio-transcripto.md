# 02 — Verificar cómo llega un audio transcripto

**Qué construir:** la verificación primero; el código depende de lo que se vea.

**Severidad:** alta · **Bloquea producción:** sí (define si el mostrador puede dictar)

## Lo que ya se verificó (04/09/2026)

Mirando las ejecuciones reales del workflow por la API de plataforma de Kapso:

```
execution_context.vars.last_user_input  =  "Hola"   (texto)
```

O sea que **al agente no le llega el payload crudo de Meta**, sino una variable
de texto. Si Kapso transcribe el audio —dice hacerlo desde el plan Free—, el
transcripto llega ahí y el agente puede resolver el pedido sin que este server
toque nada.

## Lo que falta verificar

Mandar **un audio real** al número y mirar dos cosas:

1. `GET /workflow_executions/<id>` → ¿`vars.last_user_input` trae el
   transcripto, o viene vacío?
2. El cuerpo que llega a `POST /kapso/webhook` → ¿`type: "audio"`, o Kapso lo
   normaliza a `text`?

## Según lo que se vea

- **Si `last_user_input` trae el transcripto:** no hay nada que hacer. El
  webhook ya delega estos eventos al agente (sep-2026) justamente por esto.
- **Si el webhook recibe el transcripto en algún campo del payload:** son pocas
  líneas en `normalizarEvento` para leerlo y que el webhook también lo entienda.
- **Si no hay transcripción:** hay que decidir si se contrata (plan de Kapso) o
  si el asistente pide que escriban. El texto de respaldo ya existe
  (`TEXTO_TIPO_NO_SOPORTADO`).

## Por qué importa tanto

Dictar es la forma más común de mandar un mensaje en Uruguay, y el kiosquero
tiene las manos ocupadas. Si el audio no anda, la mitad del valor del canal no
existe.
