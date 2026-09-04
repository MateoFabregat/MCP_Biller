import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Avoid real wall-clock waits from the rate limiter during tests.
    testTimeout: 15000,

    // PROCESOS, NO HILOS: LO QUE SE PUEDE MATAR.
    //
    // En CI, la suite terminaba de correr —todos los archivos en verde, el
    // último a los dos minutos— y vitest NUNCA imprimía el resumen ni salía. A
    // las seis horas GitHub mataba el job y en la limpieza aparecían los
    // huérfanos: `node (vitest)`, `node (vitest 1)` y `esbuild`. O sea que el
    // problema no era ningún test: era un worker que no se podía terminar, con
    // algún handle abierto que en macOS no queda vivo y en el runner sí.
    //
    // Un worker es un HILO del mismo proceso: si algo adentro no cierra, no hay
    // forma de forzarlo desde afuera. Un fork es un proceso: se le manda una
    // señal y se muere. Cuesta un poco más de arranque y a cambio el pipeline
    // deja de depender de que ningún test se olvide de cerrar un handle.
    //
    // `teardownTimeout` es el cinturón del cinturón: si el cierre tarda más que
    // esto, vitest corta en vez de esperar para siempre.
    pool: "forks",
    teardownTimeout: 10_000,
  },
});
