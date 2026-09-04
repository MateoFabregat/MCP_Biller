# 05 — Reintentar el 429 de Biller

**Qué construir:** que un rate limit de la API no se convierta en un error para
el usuario. Viene escrito de la ola C y quedó sin ejecutar.

**Severidad:** media · **Bloquea producción:** sí

## El problema

Los limitadores locales (`utils/rateLimit.ts`) evitan pasarse por nuestra
culpa, pero no cubren el caso de que Biller conteste 429 igual: otro proceso de
la misma empresa consumiendo el mismo token, o un límite del lado de ellos que
no conocemos. Hoy un 429 sube como error y el usuario ve "no se pudo consultar".

## Qué hacer

- Reintentar **solo GET**, con backoff exponencial y un techo bajo (2 o 3
  intentos). Respetar `Retry-After` si viene.
- **NUNCA reintentar un POST automáticamente.** Un 429 en una emisión puede
  significar que Biller la recibió: el reintento lo maneja la idempotencia, no
  un `for`.
- Que el reintento quede en el log, para que se vea si pasa seguido.
