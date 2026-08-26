// =============================================================================
// El dialecto de los schemas en el wire.
//
// Encontrado usando el server desde un cliente MCP estricto: TODAS las tools
// con outputSchema eran inllamables — "invalid outputSchema: unsupported
// dialect draft-07". Ver `transport/dialecto.ts`.
// =============================================================================

import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { conDialectoLimpio } from "../src/transport/dialecto.js";
import { crearServidorMcp } from "../src/server.js";
import { createToolContext } from "../src/tools/register.js";

describe("los schemas salen sin dialecto draft-07", () => {
  it("ningún inputSchema/outputSchema de tools/list declara draft-07", async () => {
    const ctx = createToolContext({});
    const server = crearServidorMcp(ctx, "read_only");
    const [cliente, servidor] = InMemoryTransport.createLinkedPair();
    await server.connect(conDialectoLimpio(servidor));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(cliente);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      const schemas = [tool.inputSchema, tool.outputSchema].filter(Boolean) as Array<
        Record<string, unknown>
      >;
      expect(schemas.length).toBeGreaterThan(0);
      for (const s of schemas) {
        expect(s["$schema"] ?? "", tool.name).not.toContain("draft-07");
      }
    }
    await client.close();
    await server.close();
  });

  it("SIN la envoltura, el SDK sí estampa draft-07 (si esto falla, borrá dialecto.ts)", async () => {
    // El día que el SDK (o la migración a Zod v4) emita 2020-12 solo, este test
    // se pone rojo A PROPÓSITO: es el recordatorio de que la envoltura ya no
    // hace falta y hay que borrarla, no mantenerla por las dudas.
    const ctx = createToolContext({});
    const server = crearServidorMcp(ctx, "read_only");
    const [cliente, servidor] = InMemoryTransport.createLinkedPair();
    await server.connect(servidor);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(cliente);
    const { tools } = await client.listTools();
    const conDialecto = tools.filter(
      (t) => (t.outputSchema as Record<string, unknown> | undefined)?.["$schema"] === "http://json-schema.org/draft-07/schema#",
    );
    expect(conDialecto.length).toBeGreaterThan(0);
    await client.close();
    await server.close();
  });
});
