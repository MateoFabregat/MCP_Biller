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

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";

const TEST_URL = "https://test.biller.uy";
const PROD_URL = "https://biller.uy";

interface EntornoRutaClaudeDesktop {
  plataforma?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
}

/** Ruta del claude_desktop_config.json según el sistema operativo. */
export function rutaConfigClaudeDesktop(opciones: EntornoRutaClaudeDesktop = {}): string {
  const home = opciones.home ?? homedir();
  const env = opciones.env ?? process.env;
  switch (opciones.plataforma ?? platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
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
  const yaExistia = existsSync(ruta);
  if (yaExistia) {
    const crudo = readFileSync(ruta, "utf8").trim();
    if (crudo !== "") {
      // Si el JSON existente está roto, mejor frenar que pisarlo: el archivo
      // puede tener otros servers que el usuario no quiere perder.
      config = JSON.parse(crudo) as Record<string, unknown>;
    }
  } else {
    mkdirSync(dirname(ruta), { recursive: true, mode: 0o700 });
  }
  const servidoresActuales = config.mcpServers;
  if (
    servidoresActuales !== undefined &&
    (typeof servidoresActuales !== "object" || servidoresActuales === null || Array.isArray(servidoresActuales))
  ) {
    throw new Error('La clave "mcpServers" existe pero no es un objeto JSON.');
  }
  const siguiente: Record<string, unknown> = {
    ...config,
    mcpServers: {
      ...((servidoresActuales ?? {}) as Record<string, unknown>),
      biller: bloqueServidor(token, baseUrl),
    },
  };
  const serializado = `${JSON.stringify(siguiente, null, 2)}\n`;

  // Repetir el alta exacta no toca el archivo ni crea un backup inútil con el
  // mismo secreto. La comparación es semántica: tolera otro indentado.
  if (yaExistia && JSON.stringify(config) === JSON.stringify(siguiente)) {
    chmodSync(ruta, 0o600);
    return { backup: false };
  }

  let backup = false;
  if (yaExistia) {
    // El .bak lleva el token adentro (el viejo o el mismo): 0600 para que no lo
    // lea otro usuario del sistema, igual que el archivo real.
    copyFileSync(ruta, `${ruta}.bak`);
    chmodSync(`${ruta}.bak`, 0o600);
    backup = true;
  }

  // 0600: el archivo tiene el BILLER_API_TOKEN en claro. Sin esto queda 0644 y
  // cualquier proceso de otro usuario lo lee — el escenario del host compartido
  // que el README de multi-empresa describe.
  const temporal = `${ruta}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporal, serializado, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporal, 0o600);
    renameSync(temporal, ruta);
  } finally {
    // Si write/rename falla, el config anterior sigue intacto. El temporal no
    // puede quedar abandonado con un token en claro.
    if (existsSync(temporal)) rmSync(temporal, { force: true });
  }
  chmodSync(ruta, 0o600);
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
function crearPreguntador(rl: Interface): {
  pregunta: (texto: string, oculto?: boolean) => Promise<string>;
} {
  const cola: string[] = [];
  const esperas: Array<(linea: string | null) => void> = [];
  let cerrado = false;

  // Eco controlado: cuando `ocultar` está activo, readline NO escribe las teclas
  // que el usuario tipea. Es lo que evita que el token quede en pantalla —y en el
  // scrollback, y en una videollamada con pantalla compartida, que es EL caso de
  // uso de este comando—. El prompt lo escribimos nosotros aparte, así que sigue
  // visible. Sin TTY (pipe, tests) no hay eco de por sí y esto no hace nada.
  let ocultar = false;
  const rlInterno = rl as unknown as { _writeToOutput?: (s: string) => void };
  const escribirOriginal = rlInterno._writeToOutput?.bind(rl);
  rlInterno._writeToOutput = (s: string): void => {
    if (ocultar) return;
    escribirOriginal?.(s);
  };

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
    pregunta: async (texto: string, oculto = false): Promise<string> => {
      ocultar = false;
      process.stderr.write(texto);
      ocultar = oculto;
      const finalizar = (): void => {
        ocultar = false;
        if (oculto) process.stderr.write("\n"); // el Enter no se ecoó: cerramos la línea
      };
      const encolada = cola.shift();
      if (encolada !== undefined) {
        finalizar();
        if (!oculto) process.stderr.write("\n");
        return encolada;
      }
      if (cerrado) {
        finalizar();
        throw new Error("Se terminó la entrada antes de responder todas las preguntas.");
      }
      const linea = await new Promise<string | null>((resolve) => esperas.push(resolve));
      finalizar();
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
      // `oculto`: el token no se ecoa mientras se pega. Ver `crearPreguntador`.
      token = (await pregunta(`Pegá tu token de la API de Biller (${baseUrl}): `, true)).trim();
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
