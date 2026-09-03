// =============================================================================
// biller_health_check  (solicitado: health_check)
//
// Verifica que el MCP responde y que la configuración mínima existe.
// NO llama a Biller. NUNCA expone BILLER_API_TOKEN (solo `has_token`).
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ConfigInspection } from "../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import { remitenteVerificado } from "../security/remitentes.js";
import type { ToolContext } from "./shared.js";
import {
  READ_ONLY_ANNOTATIONS,
  dualResult,
  jsonResult,
  responseFormatSchema,
  type ToolResult,
} from "./shared.js";

export interface HealthDeps {
  /**
   * La config a diagnosticar. En multi-empresa es la del TENANT, no la del
   * proceso: `inspectConfig()` sin argumento lee `process.env`, y así el health
   * check de una empresa le contestaba a otra con el RUT, la URL de la API y la
   * ruta del audit log del proceso. Por eso no hay default acá.
   */
  inspect: () => ConfigInspection;
  /**
   * ¿El que llama está en la allowlist? Decide si la salida lleva detalle o
   * booleanos. Sin default a propósito: un default permisivo convierte un olvido
   * en una filtración silenciosa.
   */
  verificado: (remitente?: string) => boolean;
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
  /**
   * `true` solo si quien llama está identificado como remitente autorizado (o si
   * no hay canal de WhatsApp y no hay a quién identificar). En `false` los
   * campos que identifican a la empresa vienen en `null` y quedan sus booleanos.
   */
  detalle_completo: z.boolean(),
  api_base_url: z.string().nullable(),
  has_token: z.boolean(),
  approval_secret_configurado: z.boolean(),
  default_empresa_rut: z.string().nullable(),
  /** Hay RUT configurado. Es el reemplazo de `default_empresa_rut` sin detalle. */
  tiene_empresa_rut: z.boolean(),
  default_sucursal_id: z.string().nullable(),
  tiene_sucursal_default: z.boolean(),
  /** Cuántas sucursales tienen nombre en BILLER_SUCURSALES_JSON (no expone los nombres). */
  sucursales_nombradas: z.number(),
  audit_log_path: z.string().nullable(),
  /** Hay audit log en disco. Reemplaza a `audit_log_path` sin detalle: la ruta es del servidor. */
  tiene_audit_log: z.boolean(),
  /** Estado del namespace de idempotencia de salidas Kapso, sin exponer ruta. */
  kapso_configurado: z.boolean(),
  kapso_idempotencia_persistente: z.boolean(),
  webhook_replay_log_path: z.string().nullable(),
  webhook_replay_ttl_ms: z.number(),
  webhook_replay_max_entries: z.number(),
  timeout_ms: z.number(),
  log_level: z.string(),
  /**
   * Barrera de entrada. Esta tool es lo único que se puede consultar sin estar
   * autorizado (ver TOOLS_SIN_REMITENTE), y por eso el bloque no lleva ni un
   * número de teléfono: solo cuántos hay y de dónde salen.
   */
  acceso: z.object({
    remitente_exigido: z.boolean(),
    remitentes_autorizados: z.number(),
    fuente_allowlist: z.enum(["propia", "destinatarios", "ninguna"]),
  }),
  warnings: z.array(z.string()),
  missing: z.array(z.string()),
  rate_limit_default_rps: z.number(),
  rate_limit_dgi_rps: z.number(),
};

function buildWarnings(c: ConfigInspection): string[] {
  const warnings: string[] = [];
  const writeToolsRegistered = c.capabilityMode === "write_enabled";

  // Los valores inválidos vuelven a su default, pero el operador tiene que
  // enterarse: de lo contrario health diría "30" sin explicar por qué su
  // configuración de "0" no tuvo efecto.
  warnings.push(...c.configWarnings);

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

  if (c.kapso.habilitado && !c.kapso.idempotenciaPersistente) {
    warnings.push(
      "Las salidas Kapso usan idempotencia en memoria: un reinicio puede perder la reserva. " +
        "Configurá KAPSO_IDEMPOTENCY_LOG_PATH o BILLER_DATA_DIR para persistirla.",
    );
  }

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
    const faltantes: string[] = [];
    if (c.auditLogPath === null) faltantes.push("audit persistente");
    if (c.idempotencyLogPath === null) faltantes.push("idempotencia fiscal persistente");
    if (Object.keys(c.maxMontos).length === 0) faltantes.push("topes de monto por moneda");
    if (c.valorUi === null || c.valorUiFecha === null) faltantes.push("valor y fecha vigente de la UI");
    if (c.kapso.habilitado && !c.kapso.idempotenciaPersistente) {
      faltantes.push("idempotencia persistente de salidas Kapso");
    }
    if (c.kapso.webhookHabilitado && c.webhookReplayLogPath === null) {
      faltantes.push("protección persistente contra replay de webhooks");
    }
    if (faltantes.length > 0) {
      warnings.push(
        `⛔ PRODUCCIÓN NO LISTA: faltan ${faltantes.join(", ")}. El gate bloqueará los POST reales.`,
      );
    }
  }

  return warnings;
}

export function buildHealthStructured(
  c: ConfigInspection,
  opciones: { detalle?: boolean } = {},
): Record<string, unknown> {
  const writeToolsRegistered = c.capabilityMode === "write_enabled";
  // POR QUÉ SE DEGRADA.
  //
  // Esta tool está exenta de la barrera de entrada para poder diagnosticar por
  // qué el resto rechaza (ver TOOLS_SIN_REMITENTE). Pero exenta no significa
  // pública: tal cual estaba, cualquiera que conociera el número de WhatsApp de
  // la empresa confirmaba que existe, su RUT, si apuntaba a producción y dónde
  // guarda el audit log, sin figurar en ninguna allowlist. Lo que se conserva
  // sin identificar es todo lo que hace falta para diagnosticar —status,
  // missing, warnings, modo de capacidad, environment— y lo que se cae son los
  // identificadores: RUT, sucursal, URL de la API y ruta en disco.
  const detalle = opciones.detalle ?? true;
  return {
    status: c.missing.length === 0 ? "ok" : "config_incompleta",
    capability_mode: c.capabilityMode,
    write_tools_registered: writeToolsRegistered,
    write_execution_enabled: c.writeEnabled,
    environment: c.environment,
    allow_production_writes: c.allowProductionWrites,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    detalle_completo: detalle,
    api_base_url: detalle ? c.apiBaseUrl : null,
    has_token: c.hasToken, // boolean — el token NUNCA se incluye
    approval_secret_configurado: c.approvalSecretConfigurado,
    default_empresa_rut: detalle ? c.defaultEmpresaRut : null,
    tiene_empresa_rut: c.defaultEmpresaRut !== null,
    default_sucursal_id: detalle ? c.defaultSucursalId : null,
    tiene_sucursal_default: c.defaultSucursalId !== null,
    sucursales_nombradas: c.sucursalesConfiguradas,
    audit_log_path: detalle ? c.auditLogPath : null,
    tiene_audit_log: c.auditLogPath !== null,
    kapso_configurado: c.kapso.habilitado,
    kapso_idempotencia_persistente: c.kapso.idempotenciaPersistente,
    webhook_replay_log_path: detalle ? c.webhookReplayLogPath : null,
    webhook_replay_ttl_ms: c.webhookReplayTtlMs,
    webhook_replay_max_entries: c.webhookReplayMaxEntries,
    timeout_ms: c.timeoutMs,
    log_level: c.logLevel,
    rate_limit_default_rps: c.rateLimitDefaultRps,
    rate_limit_dgi_rps: c.rateLimitDgiRps,
    acceso: {
      remitente_exigido: c.remitentes.exigido,
      remitentes_autorizados: c.remitentes.autorizados,
      fuente_allowlist: c.remitentes.fuente,
    },
    warnings: buildWarnings(c),
    missing: c.missing,
  };
}

/** Lo que se escribe en vez de un valor que no se muestra por falta de remitente. */
const OCULTO = "(oculto: remitente no verificado)";

function toMarkdown(s: Record<string, unknown>): string {
  const server = s.server as { name: string; version: string };
  const detalle = s.detalle_completo === true;
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
    // Sin detalle no se escribe "(no configurada)" donde hay una URL: eso sería
    // mentir sobre la config, que es exactamente lo que esta tool no puede
    // hacer. Se dice que el valor está oculto y por qué.
    `- **api_base_url**: ${s.api_base_url ?? (detalle ? "(no configurada)" : OCULTO)}`,
    `- **has_token**: ${s.has_token}`,
    `- **approval_secret_configurado**: ${s.approval_secret_configurado}`,
    `- **default_empresa_rut**: ${
      s.default_empresa_rut ?? (detalle ? "(no configurado)" : `${OCULTO} — hay RUT: ${s.tiene_empresa_rut}`)
    }`,
    `- **default_sucursal_id**: ${
      s.default_sucursal_id ??
      (detalle ? "(no configurado)" : `${OCULTO} — hay sucursal: ${s.tiene_sucursal_default}`)
    }`,
    `- **audit_log_path**: ${
      s.audit_log_path ?? (detalle ? "(solo stderr)" : `${OCULTO} — hay audit log: ${s.tiene_audit_log}`)
    }`,
    `- **kapso_configurado**: ${s.kapso_configurado}`,
    `- **kapso_idempotencia_persistente**: ${s.kapso_idempotencia_persistente}`,
    `- **webhook_replay_log_path**: ${
      s.webhook_replay_log_path ?? (detalle ? "(solo memoria)" : `${OCULTO} — hay journal: ${s.webhook_replay_log_path !== null}`)
    }`,
    `- **webhook_replay_ttl_ms**: ${s.webhook_replay_ttl_ms}`,
    `- **webhook_replay_max_entries**: ${s.webhook_replay_max_entries}`,
    `- **timeout_ms**: ${s.timeout_ms}`,
    `- **log_level**: ${s.log_level}`,
    `- **rate_limit_default_rps**: ${s.rate_limit_default_rps}`,
    `- **rate_limit_dgi_rps**: ${s.rate_limit_dgi_rps}`,
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
    ...(detalle ? [] : [`- **detalle**: reducido (llamá con un remitente autorizado para ver la config completa)`]),
    missing.length > 0
      ? `- **faltan variables**: ${missing.join(", ")}`
      : `- **config**: completa`,
    ...(warnings.length > 0
      ? [``, `## Warnings`, ...warnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");
}

export function handleHealthCheck(
  args: { response_format?: "json" | "markdown"; remitente?: string },
  deps: HealthDeps,
): ToolResult {
  const structured = buildHealthStructured(deps.inspect(), {
    detalle: deps.verificado(args.remitente),
  });
  if (args.response_format === "markdown") {
    return dualResult(structured, toMarkdown(structured));
  }
  return jsonResult(structured);
}

/**
 * `ctx` es OBLIGATORIO y no tiene default.
 *
 * Registrar esta tool sin contexto la dejaba diagnosticando `process.env`: en
 * multi-empresa, el health check de un tenant contestaba con el RUT, la URL de
 * la API, la ruta del audit log y el modo de capacidad DEL PROCESO — o sea, de
 * otra empresa. El aislamiento por tenant no participaba porque la tool nunca
 * miraba el contexto. Si algún día vuelve a aparecer un default acá, vuelve el
 * mismo agujero.
 */
export function registerHealthCheck(
  server: McpServer,
  ctx: ToolContext,
  deps: HealthDeps = {
    // Del contexto, nunca de `process.env`: ver `ToolContext.inspeccionar`.
    // Antes esto pasaba por un WeakMap en register.ts, lo que además obligaba a
    // este módulo a importar al que lo importa. El ciclo hoy lo salva el
    // hoisting de ESM, pero era una trampa esperando a que alguien moviera una
    // línea; con el dato en la interfaz no hay ciclo que resolver.
    inspect: () => ctx.inspeccionar(),
    verificado: (remitente) => {
      try {
        return remitenteVerificado(remitente, ctx.getConfig());
      } catch {
        // Config ilegible: no se puede saber si hay canal ni quién está
        // autorizado. Se degrada. Es el caso en que MÁS falta diagnosticar y
        // menos se sabe a quién se le está contestando.
        return false;
      }
    },
  },
): void {
  server.registerTool(
    "biller_health_check",
    {
      title: "Health check del MCP de Biller",
      description:
        "Verifica que el MCP responde y que la configuración mínima existe. No llama a la API de Biller. " +
        "Nunca expone el token (solo informa has_token). Sin un remitente autorizado, los datos que " +
        "identifican a la empresa (RUT, URL de la API, ruta del audit log) salen como booleanos.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Biller health check" },
    },
    async (args) => handleHealthCheck(args, deps),
  );
}
