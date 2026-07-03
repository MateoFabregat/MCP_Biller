// =============================================================================
// biller_emitir_comprobante  -> POST /v2/comprobantes/crear  (ESCRITURA)
//
// ⚠️ Emite un CFE REAL ante DGI (en test, contra DGI de test). Dos fases:
// dry-run (default) y ejecución con confirm=true + confirmation_token.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { classifyCfe, esEFactura } from "../../services/cfeTypes.js";
import {
  WRITE_ANNOTATIONS,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "../shared.js";
import { runWriteOperation, writeControlShape, writeOutputShape } from "./shared.js";

/** ¿El payload trae una referencia válida a otro CFE? (notas de crédito/débito) */
function tieneReferencia(payload: Record<string, unknown>): boolean {
  const refs = payload.referencias;
  if (Array.isArray(refs) && refs.length > 0) return true;
  const global = payload.referencia_global;
  const globalActiva = global === true || global === 1 || global === "1";
  const razon = payload.razon_referencia;
  const razonPresente = typeof razon === "string" && razon.trim().length > 0;
  return globalActiva && razonPresente;
}

/** ¿El payload trae un receptor/cliente identificado? ("-" o vacío = sin receptor) */
function tieneReceptor(payload: Record<string, unknown>): boolean {
  const c = payload.cliente;
  if (c === undefined || c === null) return false;
  if (typeof c === "string") return c.trim() !== "" && c.trim() !== "-";
  if (Array.isArray(c)) return c.length > 0;
  if (typeof c === "object") return Object.keys(c).length > 0;
  return false;
}

const ENDPOINT = "/v2/comprobantes/crear";

const inputShape = {
  comprobante: z
    .object({ tipo_comprobante: z.number().int().describe("Tipo de CFE (ver Tabla de Valores).") })
    .passthrough()
    .describe(
      "Cuerpo del CFE según la API de Biller: forma_pago, sucursal, moneda, montos_brutos, cliente, items[], etc.",
    ),
  ...writeControlShape,
};

const fullSchema = z.object(inputShape);

export async function handleEmitirComprobante(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = fullSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const payload: Record<string, unknown> = { ...a.comprobante };

  // Default de sucursal desde config (si no vino en el cuerpo).
  let defaultSucursal: string | undefined;
  try {
    defaultSucursal = ctx.getConfig().defaultSucursalId;
  } catch {
    /* config inválida: runWriteOperation devolverá el error */
  }
  if (payload.sucursal === undefined && defaultSucursal !== undefined) {
    const n = Number(defaultSucursal);
    payload.sucursal = Number.isFinite(n) ? n : defaultSucursal;
  }

  const warnings: string[] = [];
  const tipo = a.comprobante.tipo_comprobante;
  const clasif = classifyCfe(tipo);
  const items = payload.items;
  const sinItems = !Array.isArray(items) || items.length === 0;
  if (sinItems && (clasif.categoria === "venta" || clasif.categoria === "nota_credito" || clasif.categoria === "nota_debito")) {
    warnings.push(
      `El comprobante tipo ${tipo} (${clasif.etiqueta}) no incluye 'items': confirmá que el cuerpo sea correcto antes de ejecutar.`,
    );
  }

  // A) Sucursal: Biller la EXIGE para emitir (POST /v2/comprobantes/crear).
  // En execute (confirm=true) bloqueamos con un mensaje claro en vez de dejar
  // que la API devuelva un 422 confuso. En dry-run solo avisamos.
  const faltaSucursal = payload.sucursal === undefined || payload.sucursal === null || payload.sucursal === "";
  if (faltaSucursal) {
    const msg =
      "Falta 'sucursal': Biller la exige para emitir un comprobante. " +
      "Pasá 'sucursal' en el cuerpo o configurá BILLER_DEFAULT_SUCURSAL_ID con el ID real de tu sucursal " +
      "(Ajustes → Sucursales en biller.uy).";
    if (a.confirm) return simpleErrorResult(msg, ctx);
    warnings.push(`${msg} Si ejecutás así, la emisión fallará.`);
  }

  // B) Notas de crédito/débito: deben referenciar el CFE original.
  if (
    (clasif.categoria === "nota_credito" || clasif.categoria === "nota_debito") &&
    !tieneReferencia(payload)
  ) {
    warnings.push(
      `El comprobante tipo ${tipo} (${clasif.etiqueta}) es una nota de ajuste pero no incluye referencia ` +
        "al CFE original ('referencias' o 'referencia_global'+'razon_referencia'). DGI suele rechazarla sin referencia.",
    );
  }

  // B') e-Factura: receptor obligatorio (a diferencia del e-Ticket).
  if (esEFactura(tipo) && !tieneReceptor(payload)) {
    warnings.push(
      `El comprobante tipo ${tipo} (${clasif.etiqueta}) es de la familia e-Factura: DGI exige receptor ` +
        "identificado con RUT. Falta 'cliente' (o vino vacío/'-').",
    );
  }

  return runWriteOperation({
    ctx,
    tool: "biller_emitir_comprobante",
    endpoint: ENDPOINT,
    payload,
    confirm: a.confirm,
    confirmationToken: a.confirmation_token,
    idempotencyKey: a.idempotency_key,
    allowProduction: a.allow_production,
    rateLimitClass: "dgi", // creación de comprobantes: 1 req/seg
    warnings,
  });
}

export function registerEmitirComprobante(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_emitir_comprobante",
    {
      title: "Emitir comprobante (CFE) — ESCRITURA",
      description:
        "EMITE un CFE real ante DGI (POST /v2/comprobantes/crear). Por defecto hace dry-run (preview) sin red; " +
        "para ejecutar requiere confirm=true + confirmation_token, BILLER_WRITE_ENABLED=true y, en producción, allow_production=true.",
      inputSchema: inputShape,
      outputSchema: writeOutputShape,
      annotations: { ...WRITE_ANNOTATIONS, title: "Emitir comprobante (escritura)" },
    },
    async (args) => handleEmitirComprobante(args, ctx),
  );
}
