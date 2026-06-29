// =============================================================================
// Registro de tools y construcción del contexto (lectura + escritura).
//
// LECTURA: 6 tools read-only (GET).
// ESCRITURA: 6 tools POST con barreras (dry-run + confirm token + gate +
//            idempotencia + audit). La ejecución real requiere
//            BILLER_WRITE_ENABLED=true (y, en producción, allow_production).
//
// `biller_listar_clientes` (listado GET de clientes) sigue SIN registrarse:
// no hay endpoint GET documentado. (Sí existe la escritura biller_crear_cliente.)
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillerClient } from "../biller/client.js";
import { loadConfig, type BillerConfig } from "../config.js";
import { createDefaultRateLimiters } from "../utils/rateLimit.js";
import { Auditor } from "../write/audit.js";
import type { WriteExecContext } from "../write/execute.js";
import { IdempotencyStore } from "../write/idempotency.js";
import { BillerWriteClient } from "../write/writeClient.js";
import { registerBuscarClientePorRut } from "./buscarClientePorRut.js";
import { registerListarEmitidos } from "./comprobantesEmitidos.js";
import { registerListarRecibidos } from "./comprobantesRecibidos.js";
import { registerHealthCheck } from "./health.js";
import { registerObtenerComprobante } from "./obtenerComprobante.js";
import { registerResumenFacturacion } from "./resumenFacturacion.js";
import type { ToolContext } from "./shared.js";
import { registerAnularComprobante } from "./write/anularComprobante.js";
import { registerCancelarRecibo } from "./write/cancelarRecibo.js";
import { registerCargarProducto } from "./write/cargarProducto.js";
import { registerCrearCliente } from "./write/crearCliente.js";
import { registerCrearRecibo } from "./write/crearRecibo.js";
import { registerEmitirComprobante } from "./write/emitirComprobante.js";

export const READ_TOOL_NAMES = [
  "biller_health_check",
  "biller_buscar_cliente_por_rut",
  "biller_listar_comprobantes_emitidos",
  "biller_listar_comprobantes_recibidos",
  "biller_obtener_comprobante",
  "biller_resumen_facturacion_periodo",
] as const;

export const WRITE_TOOL_NAMES = [
  "biller_emitir_comprobante",
  "biller_anular_comprobante",
  "biller_crear_cliente",
  "biller_cargar_producto",
  "biller_crear_recibo",
  "biller_cancelar_recibo",
] as const;

/** Todas las tools registradas. */
export const REGISTERED_TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;

/** Tools deliberadamente NO registradas (pendientes de validación). */
export const PENDING_TOOLS = ["biller_listar_clientes"] as const;

/**
 * Contexto con config/cliente/escritura memoizados. `getConfig`/`getClient`/
 * `getWriteContext` lanzan BillerConfigError si falta configuración mínima.
 */
export function createToolContext(): ToolContext {
  let cachedConfig: BillerConfig | undefined;
  let cachedClient: BillerClient | undefined;
  let cachedWriteClient: BillerWriteClient | undefined;
  let cachedAuditor: Auditor | undefined;
  const rateLimiters = createDefaultRateLimiters();
  const idempotency = new IdempotencyStore();

  const getConfig = (): BillerConfig => {
    cachedConfig ??= loadConfig();
    return cachedConfig;
  };
  const getClient = (): BillerClient => {
    cachedClient ??= new BillerClient(getConfig(), { rateLimiters });
    return cachedClient;
  };
  const getWriteContext = (): WriteExecContext => {
    const config = getConfig();
    cachedWriteClient ??= new BillerWriteClient(config, { rateLimiters });
    cachedAuditor ??= new Auditor(config.auditLogPath);
    return { config, writeClient: cachedWriteClient, auditor: cachedAuditor, idempotency };
  };

  return { getConfig, getClient, getWriteContext };
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Lectura (read-only)
  registerHealthCheck(server);
  registerBuscarClientePorRut(server, ctx);
  registerListarEmitidos(server, ctx);
  registerListarRecibidos(server, ctx);
  registerObtenerComprobante(server, ctx);
  registerResumenFacturacion(server, ctx);

  // Escritura (con barreras)
  registerEmitirComprobante(server, ctx);
  registerAnularComprobante(server, ctx);
  registerCrearCliente(server, ctx);
  registerCargarProducto(server, ctx);
  registerCrearRecibo(server, ctx);
  registerCancelarRecibo(server, ctx);

  // biller_listar_clientes: NO registrado (sin endpoint GET documentado de listado).
}
