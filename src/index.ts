#!/usr/bin/env node
// =============================================================================
// Entrypoint MCP. Dos transportes:
//
//   stdio (default) — Claude Desktop, Claude Code, cualquier host local.
//   http            — para que un Agent Node de Kapso pueda conectarse
//                     (rechaza localhost, así que necesita URL pública).
//
// Se elige con BILLER_TRANSPORT=stdio|http.
//
// - En stdio, stdout queda reservado para el protocolo MCP: TODO log va a stderr.
// - El server arranca aunque falte configuración de Biller: así
//   `biller_health_check` puede diagnosticar. Las tools que llaman a la API
//   devuelven un error claro si la config mínima no está presente.
// - En HTTP eso NO aplica al token del transporte: sin credencial no se arranca.
// =============================================================================

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { inspectConfig, loadConfig } from "./config.js";
import { logger, setLogLevel, type LogLevel } from "./logger.js";
import { crearServidorMcp } from "./server.js";
import { ContextosPorTenant } from "./tenants/contextos.js";
import { cargarTenants, entornoDe } from "./tenants/registry.js";
import { MCP_PATH, iniciarTransporteHttp } from "./transport/http.js";
import { validarTokenDeArranque } from "./transport/httpAuth.js";
import { createToolContext, getRegisteredToolNames } from "./tools/register.js";
import { conDialectoLimpio } from "./transport/dialecto.js";

type Transporte = "stdio" | "http";

function applyLogLevel(level: string): void {
  if (level === "error" || level === "warn" || level === "info" || level === "debug") {
    setLogLevel(level as LogLevel);
  }
}

function parseTransporte(raw: string | undefined): Transporte {
  return (raw ?? "").trim().toLowerCase() === "http" ? "http" : "stdio";
}

async function main(): Promise<void> {
  const inspection = inspectConfig();
  applyLogLevel(inspection.logLevel);
  const transporte = parseTransporte(process.env.BILLER_TRANSPORT);

  if (inspection.missing.length > 0) {
    logger.warn(
      "Configuración incompleta: el server arranca igual para permitir health_check, " +
        "pero las tools que llaman a Biller fallarán hasta configurar las variables.",
      { missing: inspection.missing },
    );
  }

  const ctx = createToolContext();

  if (transporte === "http") {
    // El registro de empresas se lee ANTES que nada: si está mal, el server no
    // tiene que arrancar "a medias" atendiendo con la config del proceso — eso
    // sería servirle a todas las empresas los datos de una.
    let registro;
    try {
      registro = cargarTenants(process.env);
    } catch (err) {
      logger.error("No se puede arrancar: el registro de empresas es inválido.", {
        message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }

    // Con tenants configurados, el token global deja de ser la credencial de
    // entrada (cada empresa tiene la suya), así que no se exige.
    if (registro.tenants.length === 0) {
      // A diferencia de la config de Biller, esto NO es tolerante: un endpoint
      // HTTP sin credencial expone la contabilidad entera a quien lo encuentre.
      const problemas = validarTokenDeArranque(process.env.BILLER_HTTP_AUTH_TOKEN);
      if (problemas.length > 0) {
        logger.error("No se puede arrancar el transporte HTTP.", { problemas });
        process.exit(1);
      }
    } else if ((process.env.BILLER_HTTP_AUTH_TOKEN ?? "").trim() !== "") {
      logger.warn(
        "Hay empresas configuradas (BILLER_TENANTS_*), así que BILLER_HTTP_AUTH_TOKEN YA NO SIRVE " +
          "para entrar: cada empresa entra con su propio auth_token. Sacá esa variable para no " +
          "dejar dando vueltas una credencial que parece válida y no lo es.",
      );
    }

    const config = loadConfig();
    // Un contexto por empresa, cacheado: comparten proceso pero no el store de
    // idempotencia ni el cliente de Biller. Ver `tenants/contextos.ts`.
    const contextos = new ContextosPorTenant(process.env);
    const handle = await iniciarTransporteHttp(
      config,
      (tenant) => {
        if (tenant === null) return crearServidorMcp(ctx, config.capabilityMode);
        const configTenant = loadConfig(entornoDe(tenant, process.env));
        return crearServidorMcp(contextos.para(tenant), configTenant.capabilityMode);
      },
      registro,
    );

    if (registro.tenants.length > 0) {
      logger.info("Modo multi-empresa.", {
        empresas: registro.tenants.map((t) => t.id),
      });
    }

    if (config.httpHost === "0.0.0.0") {
      logger.warn(
        "El transporte HTTP está escuchando en 0.0.0.0 (todas las interfaces). Asegurate de que " +
          "haya TLS por delante: sin él, el bearer viaja en texto plano.",
      );
    }

    logger.info("biller-mcp-server listo (http).", {
      endpoint: `http://${config.httpHost}:${handle.port}${MCP_PATH}`,
      capability_mode: config.capabilityMode,
      tools: getRegisteredToolNames(config.capabilityMode, {
        enableIvaEstimado: config.enableIvaEstimado,
      }),
      kapso_configurado: inspection.kapso.configurado,
    });

    const apagar = (): void => {
      void handle.close().then(() => process.exit(0));
    };
    process.on("SIGINT", apagar);
    process.on("SIGTERM", apagar);
    return;
  }

  const server = crearServidorMcp(ctx, inspection.capabilityMode);
  await server.connect(
    conDialectoLimpio(new StdioServerTransport(), { quitarOutputSchema: inspection.wireLiviano }),
  );

  logger.info("biller-mcp-server listo (stdio).", {
    capability_mode: inspection.capabilityMode,
    tools: getRegisteredToolNames(inspection.capabilityMode, {
      enableIvaEstimado: inspection.enableIvaEstimado,
    }),
    api_base_url: inspection.apiBaseUrl,
    has_token: inspection.hasToken,
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Fallo al iniciar biller-mcp-server.", { message });
  process.exit(1);
});
