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

describe("wire liviano (BILLER_WIRE_LIVIANO)", () => {
  it("con quitarOutputSchema, ninguna tool lleva outputSchema y la lista pesa mucho menos", async () => {
    // El caso Kapso: 34 tools con outputSchema pesaban 159 KB y el Agent Node
    // las descartaba TODAS sin error visible — el agente quedaba con sus 3
    // tools built-in e improvisaba menús. outputSchema es opcional en MCP.
    const ctx = createToolContext({});
    const server = crearServidorMcp(ctx, "read_only");
    const [cliente, servidor] = InMemoryTransport.createLinkedPair();
    await server.connect(conDialectoLimpio(servidor, { quitarOutputSchema: true }));
    const client = new Client({ name: "t", version: "0" });
    await client.connect(cliente);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) expect(t.outputSchema, t.name).toBeUndefined();
    await client.close();
    await server.close();
  });
});

// =============================================================================
// Los `$ref`, que son los que dejaron el WhatsApp mudo.
//
// Kapso pedía `tools/list`, recibía 200 con las 34 tools y configuraba el
// agente con CERO. El rechazo es todo-o-nada: alcanzaba UNA tool con `$ref`
// para tirar la lista entera, y no quedaba error en ningún lado.
// =============================================================================

describe("los schemas salen sin $ref", () => {
  async function toolsDelWire() {
    const ctx = createToolContext({});
    const server = crearServidorMcp(ctx, "write_enabled");
    const [cliente, servidor] = InMemoryTransport.createLinkedPair();
    await server.connect(conDialectoLimpio(servidor));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(cliente);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools;
  }

  it("ningún schema de tools/list contiene un $ref", async () => {
    const tools = await toolsDelWire();
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      const serializado = JSON.stringify([tool.inputSchema, tool.outputSchema]);
      expect(serializado, tool.name).not.toContain('"$ref"');
    }
  });

  it("inlinear conserva el tipo, no solo borra el puntero", async () => {
    // El caso exacto que rompía: `hasta` salía como {"$ref": "#/properties/desde"}.
    // Borrar el puntero también lo haría pasar el test de arriba, y dejaría al
    // modelo mandando cualquier cosa en un campo de fecha. Lo que importa es que
    // `hasta` tenga el MISMO tipo y el MISMO patrón que `desde`.
    const tools = await toolsDelWire();
    const emitidos = tools.find((t) => t.name === "biller_listar_comprobantes_emitidos");
    expect(emitidos).toBeDefined();
    const props = (emitidos!.inputSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props["hasta"]!["type"]).toBe(props["desde"]!["type"]);
    expect(props["hasta"]!["pattern"]).toBe(props["desde"]!["pattern"]);
    expect(props["hasta"]!["pattern"]).toBeTruthy();
    // Y la descripción tiene que seguir siendo la del campo que apuntaba, no la
    // del apuntado: son campos distintos y lo dicen en el texto.
    expect(String(props["hasta"]!["description"])).toContain("Hasta");
  });
});
