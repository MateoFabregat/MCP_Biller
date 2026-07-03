// =============================================================================
// biller_health_check  (solicitado: health_check)
//
// Verifica que el MCP responde y que la configuración mínima existe.
// NO llama a Biller. NUNCA expone BILLER_API_TOKEN (solo `has_token`).
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectConfig, type ConfigInspection } from "../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import {
  READ_ONLY_ANNOTATIONS,
  dualResult,
  jsonResult,
  responseFormatSchema,
  type ToolResult,
} from "./shared.js";

export interface HealthDeps {
  inspect: () => ConfigInspection;
}

const inputShape = {
  response_format: responseFormatSchema,
};

const outputShape = {
  status: z.enum(["ok", "config_incompleta"]),
  capability_mode: z.enum(["read_only", "write_enabled"]),
  write_tools_registered: z.boolean(),
  write_execution_enabled: z.boolean(),
  environment: z.enum(["test", "production"]).nullable(),
  allow_production_writes: z.boolean(),
  server: z.object({ name: z.string(), version: z.string() }),
  api_base_url: z.string().nullable(),
  has_token: z.boolean(),
  default_empresa_rut: z.string().nullable(),
  default_sucursal_id: z.string().nullable(),
  audit_log_path: z.string().nullable(),
  timeout_ms: z.number(),
  log_level: z.string(),
  warnings: z.array(z.string()),
  missing: z.array(z.string()),
};

function buildWarnings(c: ConfigInspection): string[] {
  const warnings: string[] = [];
  const writeToolsRegistered = c.capabilityMode === "write_enabled";

  if (writeToolsRegistered && !c.writeEnabled) {
    warnings.push(
      "Las tools de escritura están registradas (BILLER_CAPABILITY_MODE=write_enabled) " +
        "pero la ejecución de POST está bloqueada (BILLER_WRITE_ENABLED != true). " +
        "El dry-run funciona; para ejecutar, activá BILLER_WRITE_ENABLED=true.",
    );
  }

  if (!writeToolsRegistered && c.writeEnabled) {
    warnings.push(
      "BILLER_WRITE_ENABLED=true pero las tools de escritura NO están registradas " +
        "(BILLER_CAPABILITY_MODE=read_only). Para exponerlas, configurá " +
        "BILLER_CAPABILITY_MODE=write_enabled.",
    );
  }

  if (writeToolsRegistered && c.writeEnabled && c.environment === "production" && !c.allowProductionWrites) {
    warnings.push(
      "Escritura habilitada apuntando a PRODUCCIÓN pero BILLER_ALLOW_PRODUCTION_WRITES=false. " +
        "Las operaciones quedarán bloqueadas hasta activar ese flag.",
    );
  }

  if (writeToolsRegistered && c.writeEnabled && c.allowProductionWrites && c.environment === "production") {
    warnings.push(
      "⚠️  ESCRITURA EN PRODUCCIÓN HABILITADA. Las operaciones tienen efectos fiscales " +
        "reales e irreversibles ante DGI. Usá test.biller.uy para pruebas.",
    );
  }

  return warnings;
}

export function buildHealthStructured(c: ConfigInspection): Record<string, unknown> {
  const writeToolsRegistered = c.capabilityMode === "write_enabled";
  return {
    status: c.missing.length === 0 ? "ok" : "config_incompleta",
    capability_mode: c.capabilityMode,
    write_tools_registered: writeToolsRegistered,
    write_execution_enabled: c.writeEnabled,
    environment: c.environment,
    allow_production_writes: c.allowProductionWrites,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    api_base_url: c.apiBaseUrl,
    has_token: c.hasToken, // boolean — el token NUNCA se incluye
    default_empresa_rut: c.defaultEmpresaRut,
    default_sucursal_id: c.defaultSucursalId,
    audit_log_path: c.auditLogPath,
    timeout_ms: c.timeoutMs,
    log_level: c.logLevel,
    warnings: buildWarnings(c),
    missing: c.missing,
  };
}

function toMarkdown(s: Record<string, unknown>): string {
  const server = s.server as { name: string; version: string };
  const missing = s.missing as string[];
  const warnings = s.warnings as string[];
  return [
    `# Biller MCP — health check`,
    ``,
    `- **status**: ${s.status}`,
    `- **capability_mode**: ${s.capability_mode}`,
    `- **write_tools_registered**: ${s.write_tools_registered}`,
    `- **write_execution_enabled**: ${s.write_execution_enabled}`,
    `- **environment**: ${s.environment ?? "(desconocido)"}`,
    `- **allow_production_writes**: ${s.allow_production_writes}`,
    `- **server**: ${server.name} v${server.version}`,
    `- **api_base_url**: ${s.api_base_url ?? "(no configurada)"}`,
    `- **has_token**: ${s.has_token}`,
    `- **default_empresa_rut**: ${s.default_empresa_rut ?? "(no configurado)"}`,
    `- **default_sucursal_id**: ${s.default_sucursal_id ?? "(no configurado)"}`,
    `- **audit_log_path**: ${s.audit_log_path ?? "(solo stderr)"}`,
    `- **timeout_ms**: ${s.timeout_ms}`,
    `- **log_level**: ${s.log_level}`,
    missing.length > 0
      ? `- **faltan variables**: ${missing.join(", ")}`
      : `- **config**: completa`,
    ...(warnings.length > 0
      ? [``, `## Warnings`, ...warnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");
}

export function handleHealthCheck(
  args: { response_format?: "json" | "markdown" },
  deps: HealthDeps,
): ToolResult {
  const structured = buildHealthStructured(deps.inspect());
  if (args.response_format === "markdown") {
    return dualResult(structured, toMarkdown(structured));
  }
  return jsonResult(structured);
}

export function registerHealthCheck(
  server: McpServer,
  deps: HealthDeps = { inspect: () => inspectConfig() },
): void {
  server.registerTool(
    "biller_health_check",
    {
      title: "Health check del MCP de Biller",
      description:
        "Verifica que el MCP responde y que la configuración mínima existe. No llama a la API de Biller. " +
        "Nunca expone el token (solo informa has_token).",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Biller health check" },
    },
    async (args) => handleHealthCheck(args, deps),
  );
}
