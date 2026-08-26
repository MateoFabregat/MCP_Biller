// =============================================================================
// La barrera de entrada: quién puede preguntarle a este server.
//
// Igual que security.test.ts, estos tests fijan garantías de SEGURIDAD. El que
// se pone molesto es el que está haciendo su trabajo: si uno falla, la pregunta
// no es cómo relajarlo sino qué se abrió.
//
// El caso que motivó todo esto: hasta que existió esta barrera, cualquiera que
// conociera el número de WhatsApp de la empresa le escribía y el agente le
// contestaba con los saldos de todos los clientes. La allowlist que había
// (KAPSO_DESTINATARIOS_PERMITIDOS) solo mira lo que sale por NUESTRO canal, y la
// conversación normal no sale por ahí.
// =============================================================================

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { METRICAS_NULAS } from "../src/observabilidad/metricas.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { writeControlShape } from "../src/tools/write/shared.js";
import { guardarEntrada } from "../src/security/entrada.js";
import {
  TOOLS_SIN_REMITENTE,
  remitentesAutorizados,
  requiereRemitente,
  verificarRemitente,
} from "../src/security/remitentes.js";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/tools/register.js";
import type { ToolContext, ToolResult } from "../src/tools/shared.js";
import { makeConfig } from "./fixtures.js";
import { makeCtx } from "./helpers.js";
import { BorradorStoreMemoria } from "../src/kapso/borradorStore.js";

/** Las tools de escritura leídas del disco: el test de cobertura mira la fuente. */
const DIR_WRITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/tools/write");
const ARCHIVOS_WRITE = readdirSync(DIR_WRITE)
  .filter((n) => n.endsWith(".ts") && n !== "shared.ts")
  .map((nombre) => ({ nombre, fuente: readFileSync(path.join(DIR_WRITE, nombre), "utf8") }));

const KAPSO = {
  apiKey: "kapso_key_de_prueba",
  baseUrl: "https://api.kapso.ai",
  phoneNumberId: "597907523413541",
  destinatariosPermitidos: ["59895923567"],
};

/** Config con canal de WhatsApp abierto (o sea: con barrera activa). */
function conCanal(overrides: Parameters<typeof makeConfig>[0] = {}) {
  return makeConfig({ kapso: { ...KAPSO }, ...overrides });
}

function errorDe(res: ToolResult): { kind: string; motivo?: string; message: string } {
  return (JSON.parse(res.content[0]!.text) as { error: { kind: string; motivo?: string; message: string } })
    .error;
}

// --- La regla de cuándo se exige -------------------------------------------

describe("cuándo se exige identificar al remitente", () => {
  it("NO se exige sin Kapso: en stdio el que abre el server ya es el dueño del entorno", () => {
    expect(requiereRemitente(makeConfig())).toBe(false);
    expect(verificarRemitente(undefined, makeConfig(), "biller_cuenta_corriente").ok).toBe(true);
  });

  it("se exige apenas hay un canal de WhatsApp configurado", () => {
    expect(requiereRemitente(conCanal())).toBe(true);
  });
});

// --- La allowlist efectiva --------------------------------------------------

describe("de dónde sale la allowlist de remitentes", () => {
  it("cae a la de destinatarios cuando no hay una propia", () => {
    expect(remitentesAutorizados(conCanal())).toEqual(["59895923567"]);
  });

  it("la propia gana cuando está configurada: los dos permisos se pueden separar", () => {
    const config = conCanal({ remitentesAutorizados: ["59899111222"] });
    expect(remitentesAutorizados(config)).toEqual(["59899111222"]);
  });

  it("un destinatario que NO es remitente no puede preguntar (contador que solo recibe)", () => {
    // Recibe el digest (está en destinatarios) pero no está entre los remitentes.
    const config = conCanal({ remitentesAutorizados: ["59899111222"] });
    const v = verificarRemitente("59895923567", config, "biller_cuenta_corriente");
    expect(v.ok).toBe(false);
  });
});

// --- Los tres rechazos ------------------------------------------------------

describe("los rechazos dicen cosas distintas", () => {
  it("sin allowlist se rechaza TODO, y el mensaje va dirigido al que desplegó", () => {
    const config = conCanal({ kapso: { ...KAPSO, destinatariosPermitidos: [] } });
    const v = verificarRemitente("59895923567", config, "biller_cuenta_corriente");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.motivo).toBe("sin_allowlist");
    expect(v.mensaje).toContain("BILLER_REMITENTES_AUTORIZADOS");
  });

  it("falta el parámetro: el agente tiene que reintentar con el teléfono", () => {
    const v = verificarRemitente(undefined, conCanal(), "biller_cuenta_corriente");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.motivo).toBe("falta");
    expect(v.mensaje).toContain("{{context.phone_number}}");
  });

  it("no autorizado: el agente tiene que DEJAR de intentar, y no filtrar nada", () => {
    const v = verificarRemitente("59891234567", conCanal(), "biller_cuenta_corriente");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.motivo).toBe("no_autorizado");
    // Que no reintente por otro lado: el modo de falla es el agente servicial.
    expect(v.mensaje).toContain("NO reintentes");
    // Y que no confirme siquiera la existencia de la empresa.
    expect(v.mensaje).toContain("ni si la empresa existe");
  });

  it("el número no autorizado se enmascara: es un dato personal y esto va a logs", () => {
    const v = verificarRemitente("59891234567", conCanal(), "biller_cuenta_corriente");
    if (v.ok) throw new Error("debería rechazar");
    expect(v.mensaje).not.toContain("59891234567");
    expect(v.mensaje).toContain("…4567");
  });
});

// --- Normalización ----------------------------------------------------------

describe("el formato del número no puede ser motivo de rechazo", () => {
  it.each([
    ["+598 95 923 567", "con + y espacios"],
    ["598-95-923-567", "con guiones"],
    ["  59895923567  ", "con espacios al borde"],
  ])("acepta %s (%s)", (entrada) => {
    expect(verificarRemitente(entrada, conCanal(), "biller_cuenta_corriente").ok).toBe(true);
  });

  it("devuelve el número ya normalizado, para que quien lo use no vuelva a limpiarlo", () => {
    const v = verificarRemitente("+598 95 923 567", conCanal(), "biller_cuenta_corriente");
    expect(v.ok && v.remitente).toBe("59895923567");
  });
});

// --- La exención de health_check --------------------------------------------

describe("health_check es la única exenta", () => {
  it("contesta sin remitente, incluso con la allowlist vacía", () => {
    const config = conCanal({ kapso: { ...KAPSO, destinatariosPermitidos: [] } });
    expect(verificarRemitente(undefined, config, "biller_health_check").ok).toBe(true);
  });

  it("ninguna tool que toque datos fiscales está exenta", () => {
    const exentas = [...TOOLS_SIN_REMITENTE];
    expect(exentas).toEqual(["biller_health_check"]);
  });
});

// --- La barrera es ESTRUCTURAL, no una convención ---------------------------

describe("guardarEntrada intercepta registerTool", () => {
  function servidorCon(ctx: ToolContext, handler: () => Promise<ToolResult>) {
    const server = new McpServer({ name: "t", version: "0" });
    guardarEntrada(server, ctx);
    const registradas: Array<{ name: string; config: { inputSchema?: Record<string, unknown> } }> = [];
    const originalRegister = server.registerTool.bind(server);
    // Espiamos lo que llega al SDK, después de que la barrera lo tocó.
    (server as unknown as { registerTool: unknown }).registerTool = (
      name: string,
      config: { inputSchema?: Record<string, unknown> },
      h: unknown,
    ) => {
      registradas.push({ name, config });
      return (originalRegister as unknown as (a: string, b: unknown, c: unknown) => unknown)(
        name,
        config,
        h,
      );
    };
    return { server, registradas };
  }

  it("le agrega el parámetro `remitente` al input de toda tool", () => {
    const { ctx } = makeCtx({ config: { kapso: { ...KAPSO } } });
    const server = new McpServer({ name: "t", version: "0" });
    let vista: { inputSchema?: Record<string, unknown> } | null = null;
    (server as unknown as { registerTool: unknown }).registerTool = (
      _n: string,
      c: { inputSchema?: Record<string, unknown> },
    ) => {
      vista = c;
    };
    guardarEntrada(server, ctx);
    server.registerTool(
      "biller_lo_que_sea",
      { description: "x", inputSchema: { algo: z.string() } },
      async () => ({ content: [] }) as never,
    );
    // Un parámetro que no está en el schema no lo manda ningún modelo.
    expect(vista).not.toBeNull();
    expect(Object.keys(vista!.inputSchema!)).toContain("remitente");
    expect(Object.keys(vista!.inputSchema!)).toContain("algo");
  });

  it("una tool NUEVA queda protegida sin hacer nada: el handler no llega a correr", async () => {
    const { ctx } = makeCtx({ config: { kapso: { ...KAPSO } } });
    let corrio = false;
    const server = new McpServer({ name: "t", version: "0" });
    let handlerRegistrado: ((a: unknown) => Promise<ToolResult>) | null = null;
    (server as unknown as { registerTool: unknown }).registerTool = (
      _n: string,
      _c: unknown,
      h: (a: unknown) => Promise<ToolResult>,
    ) => {
      handlerRegistrado = h;
    };
    guardarEntrada(server, ctx);
    server.registerTool("biller_tool_futura", { description: "x", inputSchema: {} }, (async () => {
      corrio = true;
      return { content: [{ type: "text", text: "secreto" }] };
    }) as never);

    const res = await handlerRegistrado!({ remitente: "59891234567" });
    // Lo importante no es solo que rechace: es que NO haya ejecutado el handler,
    // así no se gasta una request contra la cuenta ni se traen datos a memoria.
    expect(corrio).toBe(false);
    expect(res.isError).toBe(true);
    expect(errorDe(res).kind).toBe("autorizacion");
  });

  it("deja pasar al remitente autorizado", async () => {
    const { ctx } = makeCtx({ config: { kapso: { ...KAPSO } } });
    const server = new McpServer({ name: "t", version: "0" });
    let handlerRegistrado: ((a: unknown) => Promise<ToolResult>) | null = null;
    (server as unknown as { registerTool: unknown }).registerTool = (
      _n: string,
      _c: unknown,
      h: (a: unknown) => Promise<ToolResult>,
    ) => {
      handlerRegistrado = h;
    };
    guardarEntrada(server, ctx);
    server.registerTool("biller_x", { description: "x", inputSchema: {} }, (async () => ({
      content: [{ type: "text", text: "ok" }],
    })) as never);

    const res = await handlerRegistrado!({ remitente: "59895923567" });
    expect(res.isError).toBeUndefined();
  });

  it("config ilegible no se convierte en 'no estás autorizado'", async () => {
    const ctx: ToolContext = {
      getConfig: () => {
        throw new Error("no config");
      },
      getClient: () => {
        throw new Error("no config");
      },
      getWriteContext: () => {
        throw new Error("no config");
      },
      metricas: METRICAS_NULAS,
    getBorradorStore: () => new BorradorStoreMemoria(),
    };
    const server = new McpServer({ name: "t", version: "0" });
    let handlerRegistrado: ((a: unknown) => Promise<ToolResult>) | null = null;
    (server as unknown as { registerTool: unknown }).registerTool = (
      _n: string,
      _c: unknown,
      h: (a: unknown) => Promise<ToolResult>,
    ) => {
      handlerRegistrado = h;
    };
    guardarEntrada(server, ctx);
    server.registerTool("biller_x", { description: "x", inputSchema: {} }, (async () => ({
      content: [{ type: "text", text: "llegué" }],
    })) as never);

    // Sin config no hay Kapso, así que no hay canal abierto que proteger. El
    // error que corresponde es "falta configuración", y lo da la tool.
    const res = await handlerRegistrado!({});
    expect(res.content[0]!.text).toBe("llegué");
  });

  it("no rompe: `servidorCon` sigue registrando con el nombre original", () => {
    const { ctx } = makeCtx({ config: { kapso: { ...KAPSO } } });
    const { server, registradas } = servidorCon(ctx, async () => ({ content: [] }));
    server.registerTool("biller_nombre", { description: "x", inputSchema: {} }, (async () => ({
      content: [],
    })) as never);
    expect(registradas.map((r) => r.name)).toEqual(["biller_nombre"]);
  });
});

// --- El audit log contesta "quién pidió esto" -------------------------------

describe("el remitente llega al audit log", () => {
  const COMPROBANTE = {
    tipo_comprobante: 101,
    forma_pago: 1,
    sucursal: 6,
    moneda: "UYU",
    montos_brutos: 0,
    cliente: "-",
    items: [{ cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 }],
  };

  async function emitirCon(remitente: string | undefined) {
    const fx = makeCtx({
      config: { writeEnabled: true, capabilityMode: "write_enabled" },
      postResponse: { id: 1, serie: "C", numero: "1" },
    });
    const args = { comprobante: COMPROBANTE, ...(remitente === undefined ? {} : { remitente }) };
    const dry = await handleEmitirComprobante(args, fx.ctx);
    const token = (dry.structuredContent as { confirmation_token: string }).confirmation_token;
    await handleEmitirComprobante({ ...args, confirm: true, confirmation_token: token }, fx.ctx);
    return fx.auditEntries;
  }

  it("queda anotado, enmascarado, en la entrada 'executed'", async () => {
    const entradas = await emitirCon("59895923567");
    const ejecutada = entradas.find((e) => e.phase === "executed");
    expect(ejecutada?.remitente).toBe("…3567");
  });

  it("el número completo NUNCA entra al audit log", async () => {
    const entradas = await emitirCon("59895923567");
    expect(JSON.stringify(entradas)).not.toContain("59895923567");
  });

  it("sin remitente el audit sigue funcionando (server de escritorio)", async () => {
    const entradas = await emitirCon(undefined);
    expect(entradas.find((e) => e.phase === "executed")?.remitente).toBeUndefined();
  });

  it("el remitente NO entra en el hash del confirmation_token", async () => {
    // El dueño arranca la factura y el encargado la confirma: es un caso
    // legítimo y no puede leerse como "el payload cambió".
    const fx = makeCtx({
      config: { writeEnabled: true, capabilityMode: "write_enabled" },
      postResponse: { id: 1 },
    });
    const dry = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, remitente: "59895923567" },
      fx.ctx,
    );
    const token = (dry.structuredContent as { confirmation_token: string }).confirmation_token;
    const exec = await handleEmitirComprobante(
      {
        comprobante: COMPROBANTE,
        confirm: true,
        confirmation_token: token,
        remitente: "59899111222",
      },
      fx.ctx,
    );
    expect(exec.isError).toBeUndefined();
  });

  it("toda tool de escritura declara `remitente` en su input", () => {
    // Si una tool nueva se olvida de la línea, el audit log deja de contestar
    // quién pidió la emisión — y se descubre después de la emisión rara.
    expect(Object.keys(writeControlShape)).toContain("remitente");
    for (const archivo of ARCHIVOS_WRITE) {
      expect(archivo.fuente, `${archivo.nombre} no pasa remitente a runWriteOperation`).toContain(
        "remitente: a.remitente",
      );
    }
  });
});

// --- Cobertura: ninguna tool de datos queda afuera --------------------------

describe("cobertura del catálogo", () => {
  it("toda tool registrada exige remitente salvo las exentas", () => {
    const todas = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES];
    const sinBarrera = todas.filter(
      (t) => verificarRemitente(undefined, conCanal(), t).ok,
    );
    // Si este test falla porque agregaste una tool a TOOLS_SIN_REMITENTE,
    // preguntate primero si esa tool puede devolver un importe, un nombre de
    // cliente o un RUT. Si puede, no va exenta.
    expect(sinBarrera).toEqual(["biller_health_check"]);
  });
});
