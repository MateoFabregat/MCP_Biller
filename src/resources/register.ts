// =============================================================================
// Registro central de MCP Resources.
//
// Las Resources son documentos locales de solo lectura. Mantener su registro
// separado de las tools hace explícito que no reciben ToolContext, no consultan
// Biller y no dependen del modo de escritura.
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CFE_CATALOG_RESOURCE_URI,
  catalogoCfeComoTexto,
} from "./catalogoCfe.js";

export interface ResourceDescriptor {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  read: () => string | Promise<string>;
}

const CFE_CATALOG_RESOURCE: ResourceDescriptor = {
  name: "catalogo_cfe",
  uri: CFE_CATALOG_RESOURCE_URI,
  title: "Catálogo CFE de Biller",
  description:
    "Tipos de comprobante, tablas de valores y requisitos de CFE conocidos localmente por Biller MCP.",
  mimeType: "application/json",
  read: catalogoCfeComoTexto,
};

/** Registra el catálogo productivo y, exclusivamente para el harness, extras sintéticos. */
export function registerAllResources(
  server: McpServer,
  options: { testResources?: readonly ResourceDescriptor[] } = {},
): void {
  for (const resource of [CFE_CATALOG_RESOURCE, ...(options.testResources ?? [])]) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => ({
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await resource.read() }],
      }),
    );
  }
}
