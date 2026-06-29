import { describe, expect, it } from "vitest";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { handleAnularComprobante } from "../src/tools/write/anularComprobante.js";
import { handleCancelarRecibo } from "../src/tools/write/cancelarRecibo.js";
import type { ToolResult } from "../src/tools/shared.js";
import { errorOf, makeCtx, type FakeCtx } from "./helpers.js";

const COMPROBANTE = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
  montos_brutos: 0,
  cliente: "-",
  items: [{ cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 }],
};

const EMIT_RESPONSE = { id: 43574, serie: "C", numero: "2055262", hash: "ym4F2zXETOX9sw7xVxOn/6uGDdw=" };

function sc(res: ToolResult): Record<string, unknown> {
  return res.structuredContent!;
}

/** Hace dry-run, toma el token y ejecuta con confirm=true. */
async function dryRunThenExecute(
  fixture: FakeCtx,
  baseArgs: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ dry: ToolResult; exec: ToolResult; token: string }> {
  const dry = await handleEmitirComprobante(baseArgs, fixture.ctx);
  const token = sc(dry).confirmation_token as string;
  const exec = await handleEmitirComprobante(
    { ...baseArgs, confirm: true, confirmation_token: token, ...extra },
    fixture.ctx,
  );
  return { dry, exec, token };
}

describe("emitir_comprobante — dry-run / confirm", () => {
  it("dry-run NO llama a la red y devuelve confirmation_token", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE });
    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE }, fx.ctx);

    expect(sc(dry).mode).toBe("dry_run");
    expect(sc(dry).no_network_call).toBe(true);
    expect(typeof sc(dry).confirmation_token).toBe("string");
    expect(fx.postMock).not.toHaveBeenCalled();
    expect(fx.auditEntries).toHaveLength(0);
    // endpoint correcto en el preview
    expect(sc(dry).endpoint).toBe("/v2/comprobantes/crear");
  });

  it("bloquea la ejecución si la escritura está deshabilitada", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: false } });
    const { exec } = await dryRunThenExecute(fx, { comprobante: COMPROBANTE });

    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("write_disabled");
    expect(fx.postMock).not.toHaveBeenCalled();
    expect(fx.auditEntries.some((e) => e.phase === "blocked")).toBe(true);
  });

  it("ejecuta el POST cuando write_enabled=true y el token coincide", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    const { exec } = await dryRunThenExecute(fx, { comprobante: COMPROBANTE });

    expect(exec.isError).toBeUndefined();
    expect(sc(exec).mode).toBe("executed");
    expect(sc(exec).http_status).toBe(201);
    expect((sc(exec).response as Record<string, unknown>).id).toBe(43574);
    expect(fx.postMock).toHaveBeenCalledOnce();
    const opts = fx.postMock.mock.calls[0]![0];
    expect(opts.endpoint).toBe("/v2/comprobantes/crear");
    expect(opts.rateLimitClass).toBe("dgi");
    expect(opts.body.tipo_comprobante).toBe(101);
    expect(fx.auditEntries.some((e) => e.phase === "executed")).toBe(true);
  });

  it("rechaza confirm=true con token que no coincide", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    const exec = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, confirm: true, confirmation_token: "deadbeef" },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("confirmation");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("idempotencia: la misma key no se ejecuta dos veces", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    const { token } = await dryRunThenExecute(fx, { comprobante: COMPROBANTE }, {
      idempotency_key: "key-123",
    });
    expect(fx.postMock).toHaveBeenCalledOnce();

    const again = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, confirm: true, confirmation_token: token, idempotency_key: "key-123" },
      fx.ctx,
    );
    expect(again.isError).toBe(true);
    expect(errorOf(again).kind).toBe("idempotency");
    expect(fx.postMock).toHaveBeenCalledOnce(); // no se repitió
  });

  it("valida que el comprobante tenga tipo_comprobante", async () => {
    const fx = makeCtx();
    const res = await handleEmitirComprobante({ comprobante: {} }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(errorOf(res).kind).toBe("validation");
  });
});

describe("gate de producción", () => {
  const prodCfg = { apiBaseUrl: "https://biller.uy", writeEnabled: true };

  it("dry-run en producción advierte y marca gate.allowed=false sin allow_production", async () => {
    const fx = makeCtx({ config: { ...prodCfg, allowProductionWrites: false } });
    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE }, fx.ctx);
    expect(sc(dry).environment).toBe("production");
    expect((sc(dry).gate as { allowed: boolean }).allowed).toBe(false);
    expect((sc(dry).warnings as string[]).some((w) => w.includes("PRODUCCIÓN"))).toBe(true);
  });

  it("bloquea producción sin BILLER_ALLOW_PRODUCTION_WRITES + allow_production", async () => {
    const fx = makeCtx({ config: { ...prodCfg, allowProductionWrites: false } });
    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, confirm: true, confirmation_token: token, allow_production: true },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("production_blocked");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("permite producción con ambos flags habilitados", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { ...prodCfg, allowProductionWrites: true } });
    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, confirm: true, confirmation_token: token, allow_production: true },
      fx.ctx,
    );
    expect(exec.isError).toBeUndefined();
    expect(sc(exec).mode).toBe("executed");
    expect(fx.postMock).toHaveBeenCalledOnce();
  });
});

describe("anular_comprobante — validación", () => {
  it("exige id o la terna completa", async () => {
    const fx = makeCtx();
    const res = await handleAnularComprobante({ fecha_emision_hoy: 1 }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(errorOf(res).kind).toBe("validation");
  });

  it("acepta id + fecha_emision_hoy (dry-run)", async () => {
    const fx = makeCtx();
    const res = await handleAnularComprobante({ id: 2, fecha_emision_hoy: 0 }, fx.ctx);
    expect(res.isError).toBeUndefined();
    expect(sc(res).mode).toBe("dry_run");
    expect((sc(res).payload_preview as Record<string, unknown>).id).toBe(2);
  });
});

describe("cancelar_recibo — id por query", () => {
  it("dry-run liga el id en query_preview", async () => {
    const fx = makeCtx();
    const res = await handleCancelarRecibo({ id: 302968 }, fx.ctx);
    expect((sc(res).query_preview as Record<string, unknown>).id).toBe("302968");
  });

  it("ejecuta enviando el id por query", async () => {
    const fx = makeCtx({ postResponse: { id: 302968 }, config: { writeEnabled: true } });
    const dry = await handleCancelarRecibo({ id: 302968 }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleCancelarRecibo(
      { id: 302968, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(exec.isError).toBeUndefined();
    const opts = fx.postMock.mock.calls[0]![0];
    expect(opts.endpoint).toBe("/v2/recibos/cancelar");
    expect(opts.query.id).toBe("302968");
    expect(opts.body).toBeUndefined();
  });
});
