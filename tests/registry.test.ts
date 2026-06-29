import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PENDING_TOOLS,
  READ_TOOL_NAMES,
  REGISTERED_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  createToolContext,
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

describe("registro de tools", () => {
  // Requisito #13
  it("NO registra biller_listar_clientes (queda pendiente de validación)", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext());

    expect(names).not.toContain("biller_listar_clientes");
    expect(PENDING_TOOLS).toContain("biller_listar_clientes");
  });

  it("registra exactamente las tools declaradas (6 lectura + 6 escritura)", () => {
    const { server, names } = makeRecordingServer();
    registerAllTools(server, createToolContext());

    expect(names.sort()).toEqual([...REGISTERED_TOOL_NAMES].sort());
    expect(READ_TOOL_NAMES).toHaveLength(6);
    expect(WRITE_TOOL_NAMES).toHaveLength(6);
    for (const w of WRITE_TOOL_NAMES) expect(names).toContain(w);
    expect(names).toContain("biller_emitir_comprobante");
    expect(names).toContain("biller_health_check");
  });
});
