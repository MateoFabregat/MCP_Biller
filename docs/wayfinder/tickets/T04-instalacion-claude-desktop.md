# Que se instale en Claude Desktop sin leer el código

- **Estado:** abierto
- **Tipo:** task
- **Asignado:** —
- **Bloqueado por:** —

## Question

El server tiene que poder usarse desde Claude Desktop como MCP directo, no solo
por WhatsApp. Hoy corre con `node dist/index.js` y las variables exportadas a
mano en la terminal — eso no es instalable por nadie que no haya escrito el
código.

A resolver:

1. ¿Se distribuye por `npx`, o alcanza con una entrada apuntando al build local?
   El `package.json` ya declara `bin: biller-mcp-server`, así que la mitad está.
2. El bloque de configuración de Claude Desktop, listo para copiar y pegar. Hay
   un `claude_desktop_config.example.json` en la raíz — hay que verificar si
   sigue siendo correcto o quedó viejo.
3. **Las variables de entorno.** Hoy el código NO lee `.env` por su cuenta: las
   toma del entorno del proceso. Claude Desktop lanza el server sin pasar por la
   terminal, así que o se declaran en la config, o hay que cargar el `.env`.
   Decidir cuál de las dos y hacerlo funcionar.
4. Verificar de punta a punta: abrir Claude Desktop, ver las 29 tools, y hacer
   una llamada real.
5. Documentarlo en el README, en la sección que hoy asume que sabés exportar
   variables.

## Por qué está en el mapa

El dueño lo pidió explícitamente y no depende de ninguna decisión fiscal: se
puede agarrar hoy, en paralelo con cualquier otro ticket.
