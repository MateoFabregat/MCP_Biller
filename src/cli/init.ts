// =============================================================================
// `npx biller-mcp-server init` — instalación guiada para Claude Desktop / Code.
//
// POR QUÉ EXISTE
//
// Sin esto, instalar el MCP es "editá un JSON escondido en Application Support
// y pegá tu token sin equivocarte de comilla". Ahí se pierde la mitad de los
// usuarios. Este comando hace las dos preguntas que importan (token y ambiente),
// escribe el bloque en el lugar correcto y deja el resto como estaba.
//
// QUÉ NO HACE, A PROPÓSITO
//
//   · No valida el token contra la API: eso es `scripts/onboard.mjs` y
//     `biller_health_check`. Acá el objetivo es que el server quede REGISTRADO;
//     el diagnóstico fino ya existe y vive donde puede llamar a Biller.
//   · No configura escritura: siempre deja `read_only` + write apagado. Que
//     emitir comprobantes reales requiera tocar la config a mano es una
//     decisión, no una omisión.
//   · No loguea ni imprime el token. Se pega, se escribe al archivo, y el eco
//     en pantalla lo muestra recortado.
// =============================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";

const TEST_URL = "https://test.biller.uy";
const PROD_URL = "https://biller.uy";

/** Ruta del claude_desktop_config.json según el sistema operativo. */
export function rutaConfigClaudeDesktop(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

/** El bloque que se registra. `npx -y` para que Desktop no pregunte en cada arranque. */
export function bloqueServidor(token: string, baseUrl: string): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "biller-mcp-server"],
    env: {
      BILLER_API_BASE_URL: baseUrl,
      BILLER_API_TOKEN: token,
      BILLER_CAPABILITY_MODE: "read_only",
      BILLER_WRITE_ENABLED: "false",
    },
  };
}

/**
 * Mezcla el bloque en el config existente sin tocar nada más.
 * Si el archivo existe, primero deja una copia `.bak`.
 */
export function escribirConfigDesktop(ruta: string, token: string, baseUrl: string): { backup: boolean } {
  let config: Record<string, unknown> = {};
  let backup = false;
  if (existsSync(ruta)) {
    const crudo = readFileSync(ruta, "utf8").trim();
    if (crudo !== "") {
      // Si el JSON existente está roto, mejor frenar que pisarlo: el archivo
      // puede tener otros servers que el usuario no quiere perder.
      config = JSON.parse(crudo) as Record<string, unknown>;
    }
    copyFileSync(ruta, `${ruta}.bak`);
    backup = true;
  } else {
    mkdirSync(dirname(ruta), { recursive: true });
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.biller = bloqueServidor(token, baseUrl);
  config.mcpServers = servers;
  writeFileSync(ruta, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { backup };
}

function recortado(token: string): string {
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Preguntas por stdin con una COLA de líneas propia.
 *
 * `readline/promises` descarta las líneas que llegan cuando no hay una
 * `question` pendiente — con la entrada por pipe (tests, scripts) las
 * respuestas se pierden y la siguiente pregunta cuelga para siempre. Acá cada
 * `line` se encola, y una pregunta consume de la cola o espera la próxima.
 * EOF con la cola vacía es un error claro, no un cuelgue.
 */
function crearPreguntador(rl: Interface): { pregunta: (texto: string) => Promise<string> } {
  const cola: string[] = [];
  const esperas: Array<(linea: string | null) => void> = [];
  let cerrado = false;
  rl.on("line", (linea) => {
    const espera = esperas.shift();
    if (espera) espera(linea);
    else cola.push(linea);
  });
  rl.on("close", () => {
    cerrado = true;
    for (const espera of esperas.splice(0)) espera(null);
  });
  return {
    pregunta: async (texto: string): Promise<string> => {
      process.stderr.write(texto);
      const encolada = cola.shift();
      if (encolada !== undefined) {
        process.stderr.write("\n");
        return encolada;
      }
      if (cerrado) throw new Error("Se terminó la entrada antes de responder todas las preguntas.");
      const linea = await new Promise<string | null>((resolve) => esperas.push(resolve));
      if (linea === null) throw new Error("Se terminó la entrada antes de responder todas las preguntas.");
      return linea;
    },
  };
}

export async function runInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
  const { pregunta } = crearPreguntador(rl);
  try {
    process.stderr.write("Instalación del MCP de Biller\n\n");

    const respAmbiente = (await pregunta("¿Ambiente? [1] test (recomendado)  [2] producción: ")).trim();
    const baseUrl = respAmbiente === "2" ? PROD_URL : TEST_URL;
    if (baseUrl === TEST_URL) {
      process.stderr.write("→ test.biller.uy. Cuando funcione todo, repetí `init` y elegí producción.\n\n");
    }

    let token = "";
    while (token === "") {
      token = (await pregunta(`Pegá tu token de la API de Biller (${baseUrl}): `)).trim();
    }

    const destino = (
      await pregunta("¿Dónde lo registro? [1] Claude Desktop  [2] Claude Code  [3] solo mostrar config: ")
    ).trim();

    if (destino === "2") {
      // Claude Code guarda su config con `claude mcp add`; imprimir el comando
      // exacto es más robusto que adivinar el scope (user/project) por él.
      process.stderr.write(
        "\nCorré este comando (registra el server para tu usuario):\n\n" +
          `  claude mcp add biller --scope user \\\n` +
          `    --env BILLER_API_BASE_URL=${baseUrl} \\\n` +
          `    --env BILLER_API_TOKEN=<tu-token> \\\n` +
          `    -- npx -y biller-mcp-server\n\n` +
          "Reemplazá <tu-token> por el que pegaste recién (no lo imprimo por seguridad).\n",
      );
      return;
    }

    if (destino === "3") {
      const bloque = { mcpServers: { biller: bloqueServidor("<tu-token>", baseUrl) } };
      process.stderr.write(`\n${JSON.stringify(bloque, null, 2)}\n`);
      return;
    }

    const ruta = rutaConfigClaudeDesktop();
    let resultado;
    try {
      resultado = escribirConfigDesktop(ruta, token, baseUrl);
    } catch (err) {
      process.stderr.write(
        `\nNo pude escribir ${ruta}: ${err instanceof Error ? err.message : String(err)}\n` +
          "Si el JSON existente está roto, arreglalo (o borralo) y volvé a correr `init`.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `\nListo. Escribí el server "biller" en:\n  ${ruta}\n` +
        (resultado.backup ? `  (copia previa en ${ruta}.bak)\n` : "") +
        `  token: ${recortado(token)} · ambiente: ${baseUrl} · modo: solo lectura\n\n` +
        "Reiniciá Claude Desktop y probá: “¿cuánto facturé este mes?”\n",
    );
  } finally {
    rl.close();
  }
}
