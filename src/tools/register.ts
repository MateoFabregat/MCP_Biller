// =============================================================================
// Registro de tools y construcción del contexto (lectura + escritura).
//
// LECTURA: 27 tools read-only (GET). Incluye las analíticas (resumen,
//          vencimientos, cuenta corriente, alertas), que agregan sobre las
//          mismas respuestas GET.
// ESCRITURA: 7 tools POST con barreras (dry-run + confirm token + gate +
//            idempotencia + audit). La ejecución real requiere
//            BILLER_WRITE_ENABLED=true (y, en producción, allow_production).
//
// `biller_listar_clientes` (listado GET de clientes) sigue SIN registrarse:
// no hay endpoint GET documentado. (Sí existe la escritura biller_crear_cliente.)
// =============================================================================

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillerClient } from "../biller/client.js";
import { loadConfig, type BillerCapabilityMode, type BillerConfig } from "../config.js";
import { crearBorradorStore, type BorradorStore } from "../kapso/borradorStore.js";
import { RegistroMetricas } from "../observabilidad/metricas.js";
import { createDefaultRateLimiters } from "../utils/rateLimit.js";
import { Auditor } from "../write/audit.js";
import type { WriteExecContext } from "../write/execute.js";
import { crearIdempotencyStore, type IdempotencyStore } from "../write/idempotency.js";
import { BillerWriteClient } from "../write/writeClient.js";
import { registerAlertas } from "./alertas.js";
import { registerBuscarClientePorRut } from "./buscarClientePorRut.js";
import { registerCatalogoDatos } from "./catalogoDatos.js";
import { registerCohortesClientes } from "./cohortesClientes.js";
import { registerCompararPeriodos } from "./compararPeriodos.js";
import { registerComprasProveedores } from "./comprasProveedores.js";
import { registerListarEmitidos } from "./comprobantesEmitidos.js";
import { registerListarRecibidos } from "./comprobantesRecibidos.js";
import { registerCuentaCorriente } from "./cuentaCorriente.js";
import { registerEnviarComprobanteWhatsapp } from "./enviarComprobanteWhatsapp.js";
import { registerHealthCheck } from "./health.js";
import { registerEmisionGuiada } from "./emisionGuiada.js";
import { registerMenuWhatsapp } from "./menuWhatsapp.js";
import { registerMetricas } from "./metricas.js";
import { registerObtenerComprobante } from "./obtenerComprobante.js";
import { registerObtenerPdf } from "./obtenerPdf.js";
import { registerPlanAnulacion } from "./planAnulacion.js";
import { registerPlataEnRiesgo } from "./plataEnRiesgo.js";
import { registerRecordatorioCobro } from "./recordatorioCobro.js";
import { registerPosicionIva } from "./posicionIva.js";
import { registerRankingClientes } from "./rankingClientes.js";
import { registerRequisitosComprobante } from "./requisitosComprobante.js";
import { registerRankingProductos } from "./rankingProductos.js";
import { registerRankingSucursales } from "./rankingSucursales.js";
import { registerReporteDiario } from "./reporteDiario.js";
import { registerResolverNombre } from "./resolverNombre.js";
import { registerResumenFacturacion } from "./resumenFacturacion.js";
import type { ToolContext } from "./shared.js";
import { registerVencimientos } from "./vencimientos.js";
import { registerAnularComprobante } from "./write/anularComprobante.js";
import { registerCancelarRecibo } from "./write/cancelarRecibo.js";
import { registerCargarProducto } from "./write/cargarProducto.js";
import { registerCrearCliente } from "./write/crearCliente.js";
import { registerCrearPago } from "./write/crearPago.js";
import { registerCrearRecibo } from "./write/crearRecibo.js";
import { registerEmitirComprobante } from "./write/emitirComprobante.js";

export type { BillerCapabilityMode };

export const READ_TOOL_NAMES = [
  "biller_health_check",
  "biller_buscar_cliente_por_rut",
  "biller_listar_comprobantes_emitidos",
  "biller_listar_comprobantes_recibidos",
  "biller_obtener_comprobante",
  "biller_obtener_pdf",
  "biller_resumen_facturacion_periodo",
  "biller_vencimientos",
  "biller_cuenta_corriente",
  "biller_alertas_operativas",
  "biller_ranking_clientes",
  "biller_ranking_productos",
  "biller_ranking_sucursales",
  "biller_cohortes_clientes",
  "biller_comparar_periodos",
  "biller_compras_proveedores",
  "biller_plata_en_riesgo",
  "biller_reporte_diario",
  "biller_catalogo_datos",
  "biller_metricas",
  "biller_requisitos_comprobante",
  "biller_emision_guiada",
  "biller_plan_anulacion",
  "biller_resolver_nombre",
  // Canal de WhatsApp. Leen de Biller por GET; lo que "escriben" es un mensaje,
  // y su barrera es la allowlist de destinatarios, no el ciclo de confirmación
  // fiscal. Por eso viven acá y no en WRITE_TOOL_NAMES (mismo criterio que
  // biller_reporte_diario).
  "biller_menu_whatsapp",
  "biller_enviar_comprobante_whatsapp",
  "biller_recordatorio_cobro",
] as const;

/**
 * Tools de lectura OPT-IN: existen y están testeadas, pero no se registran
 * salvo que se habiliten explícitamente.
 *
 * `biller_posicion_iva` está acá porque su salida se parece demasiado a una
 * declaración jurada sin serlo: no contempla importaciones, prorrata por
 * exentos ni ajustes contables. El cálculo es correcto sobre los CFE del
 * período; el riesgo es de USO, no de código. Se habilita con
 * BILLER_ENABLE_IVA_ESTIMADO=true.
 */
export const OPT_IN_TOOL_NAMES = ["biller_posicion_iva"] as const;

export const WRITE_TOOL_NAMES = [
  "biller_emitir_comprobante",
  "biller_anular_comprobante",
  "biller_crear_cliente",
  "biller_cargar_producto",
  "biller_crear_recibo",
  "biller_cancelar_recibo",
  "biller_crear_pago",
] as const;

/** Unión completa de tools (lectura + escritura). Solo se registran todas en `write_enabled`. */
export const ALL_TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;
/** @deprecated Usar ALL_TOOL_NAMES — el nombre "REGISTERED" es ambiguo en read_only. */
export const REGISTERED_TOOL_NAMES = ALL_TOOL_NAMES;

/** Tools deliberadamente NO registradas (pendientes de validación). */
export const PENDING_TOOLS = ["biller_listar_clientes"] as const;

/**
 * Devuelve las tools que se registrarán según el modo operativo.
 * En `read_only` solo las 27 de lectura; en `write_enabled` las 34.
 */
export function getRegisteredToolNames(
  capabilityMode: BillerCapabilityMode,
  opciones: { enableIvaEstimado?: boolean } = {},
): readonly string[] {
  const base = capabilityMode === "write_enabled" ? ALL_TOOL_NAMES : READ_TOOL_NAMES;
  return opciones.enableIvaEstimado === true ? [...base, ...OPT_IN_TOOL_NAMES] : base;
}

/**
 * Contexto con config/cliente/escritura memoizados. `getConfig`/`getClient`/
 * `getWriteContext` lanzan BillerConfigError si falta configuración mínima.
 *
 * `env` existe para el modo multi-empresa: cada tenant es un overlay de
 * variables sobre las del proceso (ver `src/tenants/registry.ts`), y este es el
 * punto donde ese overlay se convierte en un cliente de Biller distinto. Por
 * default es `process.env`, o sea el comportamiento de un solo tenant.
 *
 * OJO con reusar contextos entre tenants: el store de idempotencia y el audit
 * viven acá adentro, memoizados. Un contexto compartido por dos empresas
 * compartiría también las claves de idempotencia — y una clave "ya usada" por
 * una empresa bloquearía la emisión de la otra.
 */
export function createToolContext(env: Record<string, string | undefined> = process.env): ToolContext {
  // Un registro por contexto = uno por empresa. Ver el comentario de `metricas`
  // en ToolContext: compartirlo entre tenants expondría el uso de una a la otra.
  const metricas = new RegistroMetricas();
  let cachedConfig: BillerConfig | undefined;
  let cachedClient: BillerClient | undefined;
  let cachedWriteClient: BillerWriteClient | undefined;
  let cachedAuditor: Auditor | undefined;
  const rateLimiters = createDefaultRateLimiters();
  // La persistencia se resuelve perezosamente: la ruta vive en la config, que
  // puede no estar disponible al construir el contexto.
  let cachedIdempotency: IdempotencyStore | undefined;
  // Igual que el de idempotencia: la ruta vive en la config, que puede no estar
  // disponible al construir el contexto. Si la config no carga, memoria — un
  // flujo de emisión sin store funciona (peor), pero sin store NO funciona.
  let cachedBorradores: BorradorStore | undefined;

  const getConfig = (): BillerConfig => {
    cachedConfig ??= loadConfig(env);
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
    cachedIdempotency ??= crearIdempotencyStore(config.idempotencyLogPath);
    return {
      config,
      writeClient: cachedWriteClient,
      auditor: cachedAuditor,
      idempotency: cachedIdempotency,
    };
  };

  const getBorradorStore = (): BorradorStore => {
    if (cachedBorradores === undefined) {
      let path: string | undefined;
      try {
        path = getConfig().borradorStorePath;
      } catch {
        path = undefined;
      }
      cachedBorradores = crearBorradorStore(path);
    }
    return cachedBorradores;
  };

  return { getConfig, getClient, getWriteContext, metricas, getBorradorStore };
}

export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
  capabilityMode: BillerCapabilityMode = "read_only",
): void {
  // Las tools de lectura se registran siempre.
  registerHealthCheck(server);
  registerBuscarClientePorRut(server, ctx);
  registerListarEmitidos(server, ctx);
  registerListarRecibidos(server, ctx);
  registerObtenerComprobante(server, ctx);
  registerObtenerPdf(server, ctx);
  registerResumenFacturacion(server, ctx);
  registerVencimientos(server, ctx);
  registerCuentaCorriente(server, ctx);
  registerAlertas(server, ctx);
  registerRankingClientes(server, ctx);
  registerRankingProductos(server, ctx);
  registerRankingSucursales(server, ctx);
  registerCohortesClientes(server, ctx);
  registerCompararPeriodos(server, ctx);
  registerComprasProveedores(server, ctx);
  registerPlataEnRiesgo(server, ctx);
  registerReporteDiario(server, ctx);
  registerCatalogoDatos(server, ctx);
  registerMetricas(server, ctx);
  registerRequisitosComprobante(server, ctx);
  registerEmisionGuiada(server, ctx);
  registerPlanAnulacion(server, ctx);
  registerResolverNombre(server, ctx);
  registerMenuWhatsapp(server, ctx);
  registerEnviarComprobanteWhatsapp(server, ctx);
  registerRecordatorioCobro(server, ctx);

  // Opt-in: ver OPT_IN_TOOL_NAMES. `getConfig` puede lanzar si la config está
  // incompleta; en ese caso simplemente no se registra.
  let ivaHabilitado = false;
  try {
    ivaHabilitado = ctx.getConfig().enableIvaEstimado;
  } catch {
    ivaHabilitado = false;
  }
  if (ivaHabilitado) registerPosicionIva(server, ctx);

  // Las tools de escritura solo en modo write_enabled.
  if (capabilityMode === "write_enabled") {
    registerEmitirComprobante(server, ctx);
    registerAnularComprobante(server, ctx);
    registerCrearCliente(server, ctx);
    registerCargarProducto(server, ctx);
    registerCrearRecibo(server, ctx);
    registerCancelarRecibo(server, ctx);
    registerCrearPago(server, ctx);
  }

  // biller_listar_clientes: NO registrado (sin endpoint GET documentado de listado).
}
