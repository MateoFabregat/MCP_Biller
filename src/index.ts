#!/usr/bin/env node
// =============================================================================
// Entrypoint MCP (stdio).
//
// - stdout queda reservado para el protocolo MCP; TODO log va a stderr.
// - El server arranca aunque falte configuración: así `biller_health_check`
//   puede diagnosticar. Las tools que llaman a Biller devuelven un error claro
//   si la config mínima no está presente.
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { inspectConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { logger, setLogLevel, type LogLevel } from "./logger.js";
import { createToolContext, registerAllTools, REGISTERED_TOOL_NAMES } from "./tools/register.js";

function applyLogLevel(level: string): void {
  if (level === "error" || level === "warn" || level === "info" || level === "debug") {
    setLogLevel(level as LogLevel);
  }
}

async function main(): Promise<void> {
  const inspection = inspectConfig();
  applyLogLevel(inspection.logLevel);

  if (inspection.missing.length > 0) {
    logger.warn(
      "Configuración incompleta: el server arranca igual para permitir health_check, " +
        "pero las tools que llaman a Biller fallarán hasta configurar las variables.",
      { missing: inspection.missing },
    );
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx = createToolContext();
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("biller-mcp-server listo (stdio).", {
    tools: REGISTERED_TOOL_NAMES,
    read_only: true,
    api_base_url: inspection.apiBaseUrl,
    has_token: inspection.hasToken,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Fallo al iniciar biller-mcp-server.", { message });
  process.exit(1);
});
