import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { TIPOS_COMPROBANTE } from "../src/biller/cfeSchema.js";
import { CFE_CATALOG_RESOURCE_URI } from "../src/resources/catalogoCfe.js";
import { registerAllResources } from "../src/resources/register.js";
import { crearServidorMcp } from "../src/server.js";
import { handleRequisitosComprobante } from "../src/tools/requisitosComprobante.js";
import { createToolContext } from "../src/tools/register.js";
import { makeUnconfiguredCtx } from "./helpers.js";

async function conectar(server: McpServer) {
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(cliente);
  return { client, server };
}

describe("MCP Resources", () => {
  it("registra la costura central y permite al harness leer un Resource sintético", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerAllResources(server, {
      testResources: [{
        name: "sintetico",
        uri: "test://resource/sintetico",
        title: "Sintético",
        description: "Solo para el harness de protocolo.",
        mimeType: "text/plain",
        read: () => "respuesta sintética",
      }],
    });
    const { client } = await conectar(server);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("test://resource/sintetico");
    const result = await client.readResource({ uri: "test://resource/sintetico" });
    expect(result.contents).toEqual([
      { uri: "test://resource/sintetico", mimeType: "text/plain", text: "respuesta sintética" },
    ]);
    await client.close();
    await server.close();
  });

  it.each(["read_only", "write_enabled"] as const)("publica el catálogo CFE en %s", async (mode) => {
    const server = crearServidorMcp(createToolContext({}), mode);
    const { client } = await conectar(server);
    const { resources } = await client.listResources();
    const catalogo = resources.find((r) => r.uri === CFE_CATALOG_RESOURCE_URI);
    expect(catalogo).toMatchObject({
      name: "catalogo_cfe",
      mimeType: "application/json",
      title: "Catálogo CFE de Biller",
    });
    expect(resources.map((r) => r.uri)).not.toContain("test://resource/sintetico");

    const result = await client.readResource({ uri: CFE_CATALOG_RESOURCE_URI });
    const content = result.contents[0];
    const text = content !== undefined && "text" in content ? content.text : undefined;
    expect(typeof text).toBe("string");
    const resource = JSON.parse(text!) as { tipos_comprobante: Record<string, string>; requisitos_por_tipo: Record<string, unknown> };
    expect(resource.tipos_comprobante).toEqual(TIPOS_COMPROBANTE);
    expect(Object.keys(resource.requisitos_por_tipo).sort()).toEqual(Object.keys(TIPOS_COMPROBANTE).sort());
    const tool = handleRequisitosComprobante({ tipo_comprobante: 101 }, makeUnconfiguredCtx());
    expect(resource.requisitos_por_tipo["101"]).toMatchObject({
      requisitos: tool.structuredContent!.requisitos,
      reglas_dgi: tool.structuredContent!.reglas_dgi,
    });
    await client.close();
    await server.close();
  });
});
