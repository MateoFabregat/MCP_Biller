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
import { MCP_PATH, iniciarTransporteHttp, rutaWebhookTenant } from "./transport/http.js";
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
  // Subcomando de instalación: `npx biller-mcp-server init`. Se resuelve antes
  // de tocar la config porque su gracia es correr en una máquina SIN config.
  if (process.argv[2] === "init") {
    const { runInit } = await import("./cli/init.js");
    await runInit();
    return;
  }

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
      // El webhook lee este store para saber si la conversación tiene una
      // emisión a medio cargar. Es el MISMO que usan las tools en modo de una
      // sola empresa, que es lo que hace que el dato sea el de verdad y no una
      // copia vacía. CON EMPRESAS CONFIGURADAS NO SE USA: ahí el store sale del
      // contexto del tenant, abajo.
      ctx.getBorradorStore(),
      {
        // CÓMO EL WEBHOOK CONSIGUE LA CONFIG Y EL STORE DE CADA EMPRESA.
        //
        // El transporte no sabe armar un contexto ni una config: acá está el
        // cache que ya sirve a las tools (`ContextosPorTenant`), y de ahí salen
        // las dos cosas que el webhook necesitaba y tomaba del proceso. El
        // BorradorStore es el que importa: está salado con el `cacheId` de esta
        // empresa, así que el del proceso no resuelve NINGUNA clave de sesión de
        // NINGÚN tenant y el borrador a medio cargar se pierde en silencio.
        //
        // Se reusa el contexto cacheado en vez de construir uno por request
        // porque el store en memoria ES el estado: uno nuevo por evento sería un
        // store siempre vacío, o sea el mismo bug con otra causa.
        resolverAmbitoWebhook: (tenant) => {
          try {
            const ctxTenant = contextos.para(tenant);
            return {
              tenantId: tenant.id,
              config: ctxTenant.getConfig(),
              borradores: ctxTenant.getBorradorStore(),
            };
          } catch (err) {
            // Config incompleta: la ruta de esta empresa no existe (404), igual
            // que sin secreto. Se loguea porque un número mudo sin explicación
            // es lo más caro de diagnosticar que hay.
            logger.error("kapso.webhook.ambito_no_resoluble", {
              empresa: tenant.id,
              message: err instanceof Error ? err.message : String(err),
            });
            return null;
          }
        },
      },
    );

    if (registro.tenants.length > 0) {
      logger.info("Modo multi-empresa.", {
        empresas: registro.tenants.map((t) => t.id),
        // La ruta de webhook de cada una, para copiarla al panel de Kapso sin
        // tener que deducirla. La vieja `/kapso/webhook` ya no atiende: con
        // empresas configuradas devuelve 404 y loguea en error.
        webhooks: registro.tenants.map((t) => rutaWebhookTenant(t.id)),
      });

      // Un tenant con secreto de webhook y sin número declarado es un webhook
      // que va a autenticar bien y después descartar TODO: sin
      // `KAPSO_PHONE_NUMBER_ID` en el índice, el `phone_number_id` del cuerpo no
      // mapea a nadie. Es exactamente el "número mudo" que cuesta una tarde
      // diagnosticar, así que se avisa al arrancar y no al primer mensaje.
      const mudos = registro.tenants.filter(
        (t) =>
          (t.env.KAPSO_WEBHOOK_SECRET ?? "").trim() !== "" &&
          (t.env.KAPSO_PHONE_NUMBER_ID ?? "").trim() === "",
      );
      if (mudos.length > 0) {
        logger.warn(
          "Hay empresas con KAPSO_WEBHOOK_SECRET y sin KAPSO_PHONE_NUMBER_ID: su webhook va a " +
            "verificar la firma y descartar igual todo lo que entre, porque el número receptor no " +
            "mapea a ninguna empresa. Declaralo en el 'env' de cada una.",
          { empresas: mudos.map((t) => t.id) },
        );
      }
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
