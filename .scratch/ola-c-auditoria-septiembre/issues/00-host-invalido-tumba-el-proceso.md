# 00 — Un header Host inválido tumba el proceso entero

**What to build:** que ninguna request malformada pueda matar el server, y que un `Host` que no parsea se responda 400.

**Blocked by:** None. **HACER PRIMERO.**
**Status:** ready-for-agent
**Severidad:** ALTA · **Archivos:** `src/transport/http.ts`, `src/index.ts`

## Evidencia

En el callback de `createServer`, `new URL(req.url ?? "/", \`http://${req.headers.host ?? "localhost"}\`)` corre **adentro** de un `void (async () => {…})()` y **antes** del `try`. Un `Host` que no parsea lanza `TypeError: Invalid URL`, nadie lo captura, y Node mata el proceso por unhandled rejection. No hay `process.on("unhandledRejection")` en `src/`.

**No hace falta bearer, ni firma, ni cuerpo.** Reproducido:

```
printf 'GET /healthz HTTP/1.1\r\nHost: [\r\n\r\n' | nc 127.0.0.1 8848
```

→ `TypeError: Invalid URL` → el proceso termina con código 1. Igual con `Host:` vacío, `Host: a b`, `Host: localhost:99999`.

Es el peor modo de falla de este proyecto: el WhatsApp de **todas** las empresas queda mudo, y el que lo hizo no necesitó ninguna credencial.

## Qué hacer

1. Helper arriba del archivo:
   ```ts
   function rutaDe(req: IncomingMessage): string | null {
     try { return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname; }
     catch { return null; }
   }
   ```
2. Reemplazar la construcción de la URL por `const pathname = rutaDe(req); if (pathname === null) { responderJson(res, 400, { error: "bad_request" }); return; }`, y usar `pathname` en todos los lugares donde hoy se usa `url.pathname`.
3. **Mover el `try {` para que envuelva TODO el cuerpo del IIFE** desde la primera línea. El `catch` existente ya loguea y responde 500 si `!res.headersSent`.
4. `src/index.ts`, al arrancar el transporte HTTP: registrar `process.on("unhandledRejection", …)` que loguee y NO termine el proceso. Un server de facturación no se cae por una promesa suelta.

## Invariantes

- El 400 no dice por qué: un `Host` inválido no merece diagnóstico.
- No cambiar el ruteo ni el orden de las barreras.
- La red de última instancia loguea, no traga en silencio: tiene que quedar rastro.

## Acceptance criteria

- [ ] Test en `tests/httpTransport.test.ts`: abrir un socket crudo con `net.connect`, mandar `GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n`, esperar `HTTP/1.1 400`, y **después** un `fetch` normal a `/healthz` que responda 200. Repetir con `Host:` vacío.
- [ ] `npx vitest run tests/httpTransport.test.ts` pasa.
- [ ] `npm run typecheck` y `npm test` pasan.
