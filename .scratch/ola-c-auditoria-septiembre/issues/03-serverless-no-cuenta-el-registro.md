# 03 — Un error del registro no le cuenta la topología a un cliente sin autenticar

**What to build:** que los errores de configuración en serverless se loguen completos y se devuelvan genéricos.

**Blocked by:** None.
**Status:** ready-for-agent
**Severidad:** baja · **Archivo:** `src/transport/serverless.ts`

## Evidencia

`cargarTenants` corre ANTES de `autenticarConTenants` y su mensaje se devuelve tal cual. Una request sin `Authorization` recibe hoy:

```
500 {"error":{"message":"Registro de empresas inválido: Los tenants \"panaderia-rivera\" y \"ferreteria-centro\" declaran el MISMO KAPSO_PHONE_NUMBER_ID (\"1234…\")…"}}
```

Son ids de empresas, un `phone_number_id` y —en otro error— la ruta absoluta del archivo. No hay secretos (verificados los diez `throw`), pero es reconocimiento gratis, y justo mientras el operador está editando el registro.

## Qué hacer

En los dos `catch` (el del registro y el de la configuración):
- `logger.error("serverless.registro.invalido", { message })` con el detalle completo.
- Responder `"Registro de empresas inválido. Revisá los logs del server."` (y el equivalente para la config, agregando `empresa` al log cuando ya se autenticó).

## Acceptance criteria

- [ ] Test en `tests/serverless.test.ts`: con dos tenants que comparten `KAPSO_PHONE_NUMBER_ID` y sin `Authorization`, la respuesta es 500 y el cuerpo NO contiene `KAPSO_PHONE_NUMBER_ID`, ningún id de tenant ni `/`.
- [ ] El log sí contiene el detalle.
- [ ] Restaurar `process.env` en `afterEach`.
- [ ] `npm run typecheck` y `npm test` pasan.
