import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PENDING_TOOLS,
  READ_TOOL_NAMES,
  REGISTERED_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  createToolContext,
  getRegisteredToolNames,
  registerAllTools,
} from "../src/tools/register.js";

/** Server falso que solo registra nombres de tools. */
function makeRecordingServer(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
      return undefined;
    },
  } as unknown as McpServer;
  return { server, names };
}

describe("modo read_only (default)", () => {
  it("registra solo las 6 tools de lectura", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext(), "read_only");

    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(names).toHaveLength(6);
    for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w);
  });

  it("NO registra biller_listar_clientes", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext(), "read_only");

    expect(names).not.toContain("biller_listar_clientes");
    expect(PENDING_TOOLS).toContain("biller_listar_clientes");
  });

  it("getRegisteredToolNames devuelve solo lectura en read_only", () => {
    const names = getRegisteredToolNames("read_only");
    expect([...names].sort()).toEqual([...READ_TOOL_NAMES].sort());
  });
});

describe("modo write_enabled", () => {
  it("registra las 12 tools (6 lectura + 6 escritura)", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext(), "write_enabled");

    expect(names.sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
    expect(names).toHaveLength(12);
    expect(READ_TOOL_NAMES).toHaveLength(6);
    expect(WRITE_TOOL_NAMES).toHaveLength(6);
    for (const w of WRITE_TOOL_NAMES) expect(names).toContain(w);
    expect(names).toContain("biller_emitir_comprobante");
    expect(names).toContain("biller_health_check");
  });

  it("NO registra biller_listar_clientes ni en write_enabled", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext(), "write_enabled");

    expect(names).not.toContain("biller_listar_clientes");
  });

  it("getRegisteredToolNames devuelve todas en write_enabled", () => {
    const names = getRegisteredToolNames("write_enabled");
    expect([...names].sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
  });
});

describe("default sin pasar modo", () => {
  it("sin capabilityMode se comporta como read_only", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext());

    expect(names).toHaveLength(6);
    for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w);
  });
});
