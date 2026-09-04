# 09 — Infraestructura: dominio, secretos, backup, monitoreo

**Qué construir:** lo que falta para que esto se pueda operar, no solo correr.

**Severidad:** alta · **Bloquea producción:** sí

## Lo que falta, y en qué estado está

| Qué | Hoy | Qué falta |
|---|---|---|
| Dominio HTTPS | túnel ngrok | uno estable; Kapso rechaza localhost y el túnel se cae |
| Secretos | `.env` en disco (0600) | fuera del filesystem del server |
| Journals (audit, idempotencia ×2, replay) | `.biller/` local | volumen persistente **y backup**: sin ellos, un reinicio pierde la defensa contra emitir dos veces |
| Readiness | `/readyz` ya existe y dice qué falta | apuntarlo desde el orquestador para que no mande tráfico a un server que va a bloquear |
| Monitoreo | logs estructurados a stderr | recolección + alerta sobre `kapso.salida.bloqueada_por_reserva`, 5xx y `PRODUCCIÓN NO LISTA` |
| Rollback | ninguno | procedimiento escrito: qué se revierte y qué NO (un CFE emitido no se revierte, se anula) |
| Réplicas | una sola instancia (ADR-003) | store compartido, cuando haga falta |
| Token | el de TEST, pegado en una conversación | uno nuevo y específico de producción |

## El orden que importa

Dominio → secretos → volumen con backup → readiness en el orquestador →
monitoreo. Sin los tres primeros, el resto no tiene dónde apoyarse.
