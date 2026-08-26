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
  /** Cuántas sucursales tienen nombre en BILLER_SUCURSALES_JSON (no expone los nombres). */
  sucursales_nombradas: z.number(),
  audit_log_path: z.string().nullable(),
  timeout_ms: z.number(),
  log_level: z.string(),
  /**
   * Barrera de entrada. Es lo único que se puede consultar sin estar autorizado
   * (ver TOOLS_SIN_REMITENTE), y por eso no lleva ni un número: solo cuántos hay
   * y de dónde salen.
   */
  acceso: z.object({
    remitente_exigido: z.boolean(),
    remitentes_autorizados: z.number(),
    fuente_allowlist: z.enum(["propia", "destinatarios", "ninguna"]),
  }),
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

  // Un número mal formateado en la allowlist hace que el envío se rechace sin
  // explicación aparente: conviene verlo en el health check, no al fallar.
  warnings.push(...c.kapso.advertencias);
  warnings.push(...c.remitentes.advertencias);

  // El estado más peligroso posible: canal de WhatsApp abierto sin nadie
  // autorizado. La barrera de entrada rechaza todo, así que el server se ve
  // "roto" — y la tentación es sacar la barrera en vez de poner la allowlist.
  if (c.remitentes.exigido && c.remitentes.autorizados === 0) {
    warnings.push(
      "⚠️  Hay canal de WhatsApp configurado y NINGÚN remitente autorizado: todas las tools " +
        "rechazan por seguridad. Configurá BILLER_REMITENTES_AUTORIZADOS (o " +
        "KAPSO_DESTINATARIOS_PERMITIDOS) con los teléfonos que pueden consultar. No es un bug: sin " +
        "allowlist, cualquiera que conozca el número de WhatsApp lee la contabilidad de la empresa.",
    );
  }

  if (writeToolsRegistered && c.writeEnabled && c.allowProductionWrites && c.environment === "production") {
    warnings.push(
      "⚠️  ESCRITURA EN PRODUCCIÓN HABILITADA. Cada emisión genera un documento fiscal REAL " +
        "ante DGI. Se puede corregir (nota de crédito para anular, nota de débito para revertir " +
        "la anulación), pero cada corrección es otro comprobante emitido. Usá test.biller.uy para pruebas.",
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
    sucursales_nombradas: c.sucursalesConfiguradas,
    audit_log_path: c.auditLogPath,
    timeout_ms: c.timeoutMs,
    log_level: c.logLevel,
    acceso: {
      remitente_exigido: c.remitentes.exigido,
      remitentes_autorizados: c.remitentes.autorizados,
      fuente_allowlist: c.remitentes.fuente,
    },
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
    ...(() => {
      const a = s.acceso as {
        remitente_exigido: boolean;
        remitentes_autorizados: number;
        fuente_allowlist: string;
      };
      return [
        `- **remitente exigido**: ${a.remitente_exigido}` +
          (a.remitente_exigido
            ? ` (${a.remitentes_autorizados} autorizados, allowlist ${a.fuente_allowlist})`
            : " (sin canal de WhatsApp)"),
      ];
    })(),
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
