import { describe, expect, it } from "vitest";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { handleAnularComprobante } from "../src/tools/write/anularComprobante.js";
import { handleCancelarRecibo } from "../src/tools/write/cancelarRecibo.js";
import { handleCrearCliente } from "../src/tools/write/crearCliente.js";
import { handleCargarProducto } from "../src/tools/write/cargarProducto.js";
import { handleCrearRecibo } from "../src/tools/write/crearRecibo.js";
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
    expect(sc(dry).endpoint).toBe("/v3/comprobantes/emitir");
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
    expect(opts.endpoint).toBe("/v3/comprobantes/emitir");
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

  it("el MISMO token no emite dos veces, aunque no venga idempotency_key", async () => {
    // ESTE ERA EL AGUJERO. La clave se generaba con `randomUUID()` cuando el
    // agente no la mandaba —y no tiene por qué acordarse—, así que cada
    // `confirm` traía una clave distinta, el registro de idempotencia no
    // reconocía el reintento y la escritura pasaba de nuevo. Un timeout de
    // Kapso o un reintento del modelo emitían DOS CFE ante DGI, y dos CFE no se
    // deshacen: se anulan con dos notas de crédito.
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    const { token } = await dryRunThenExecute(fx, { comprobante: COMPROBANTE });
    expect(fx.postMock).toHaveBeenCalledOnce();

    const reintento = await handleEmitirComprobante(
      { comprobante: COMPROBANTE, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(reintento.isError).toBe(true);
    expect(errorOf(reintento).kind).toBe("idempotency");
    expect(fx.postMock).toHaveBeenCalledOnce();
  });

  it("dos ventas distintas SÍ emiten dos veces", async () => {
    // La contracara, y es deliberada: bloquear de más sería peor. Dos previews
    // distintos son el usuario haciendo dos operaciones, no un reintento.
    //
    // EL BORDE, ANOTADO PORQUE ES REAL: el token lleva el instante del dry-run,
    // así que dos previews del MISMO payload en el MISMO milisegundo dan el
    // mismo token y la segunda emisión se bloquea. En el flujo real no se
    // alcanza —entre un dry-run y el siguiente hay una persona leyendo un
    // preview—, pero si algún día se emite en lote desde código, esto es lo
    // que hay que mirar primero.
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    await dryRunThenExecute(fx, { comprobante: COMPROBANTE });
    await dryRunThenExecute(fx, {
      comprobante: { ...COMPROBANTE, items: [{ ...COMPROBANTE.items[0], cantidad: 3 }] },
    });
    expect(fx.postMock).toHaveBeenCalledTimes(2);
  });

  it("valida que el comprobante tenga tipo_comprobante", async () => {
    const fx = makeCtx();
    const res = await handleEmitirComprobante({ comprobante: {} }, fx.ctx);
    expect(res.isError).toBe(true);
    expect(errorOf(res).kind).toBe("validation");
  });
});

describe("emitir_comprobante — validaciones de negocio (A/B)", () => {
  it("bloquea la EJECUCIÓN si falta sucursal y no hay default", async () => {
    const fx = makeCtx();
    const sinSucursal = { ...COMPROBANTE };
    delete (sinSucursal as Record<string, unknown>).sucursal;
    const dry = await handleEmitirComprobante({ comprobante: sinSucursal }, fx.ctx);
    // dry-run avisa pero no rompe
    expect(sc(dry).mode).toBe("dry_run");
    expect((sc(dry).warnings as string[]).some((w) => /sucursal/i.test(w))).toBe(true);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleEmitirComprobante(
      { comprobante: sinSucursal, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("validation");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("toma la sucursal del default y permite emitir", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true, defaultSucursalId: "347" } });
    const sinSucursal = { ...COMPROBANTE };
    delete (sinSucursal as Record<string, unknown>).sucursal;
    const { exec, dry } = await dryRunThenExecute(fx, { comprobante: sinSucursal });
    expect((sc(dry).payload_preview as Record<string, unknown>).sucursal).toBe(347);
    expect(sc(exec).mode).toBe("executed");
  });

  it("avisa si una nota de crédito va sin referencia", async () => {
    const fx = makeCtx();
    const nc = { ...COMPROBANTE, tipo_comprobante: 102, sucursal: 6 };
    const dry = await handleEmitirComprobante({ comprobante: nc }, fx.ctx);
    expect((sc(dry).warnings as string[]).some((w) => /referencia/i.test(w))).toBe(true);
  });

  it("avisa si una e-Factura va sin receptor", async () => {
    const fx = makeCtx();
    const eFactura = { ...COMPROBANTE, tipo_comprobante: 111, cliente: "-" };
    const dry = await handleEmitirComprobante({ comprobante: eFactura }, fx.ctx);
    expect((sc(dry).warnings as string[]).some((w) => /e-Factura|receptor/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SEC-A3: BILLER_MAX_MONTO_* tiene que aplicar a la emisión.
//
// El tope existe por una coma mal puesta ("facturale 1.500" leído como
// 1.500.000), o sea por la emisión. Y era justo la operación que se salteaba:
// `extraerMonto` busca `total` en la raíz del payload y un ComprobanteBody no
// lo tiene — el total de un CFE es la suma de sus líneas.
// ---------------------------------------------------------------------------

describe("el tope de monto aplica a emitir_comprobante", () => {
  const CARO = {
    ...COMPROBANTE,
    items: [{ cantidad: 1, concepto: "Pelota", precio: 999_999_999, indicador_facturacion: 3 }],
  };

  it("BLOQUEA la ejecución y no llega a la API", async () => {
    const fx = makeCtx({
      postResponse: EMIT_RESPONSE,
      config: { writeEnabled: true, maxMontos: { UYU: 100_000 } },
    });
    const { exec } = await dryRunThenExecute(fx, { comprobante: CARO });

    expect(exec.isError).toBe(true);
    const err = errorOf(exec);
    // El mensaje tiene que dejar ver de un vistazo si fue un typo o una venta
    // real: por eso dice el monto Y el tope. Y el monto es el TOTAL CON IVA
    // —999.999.999 + 22%—, que es la plata que iba a salir facturada, no el
    // neto de las líneas.
    expect(err.message).toContain("1.219.999.998");
    expect(err.message).toContain("100.000");
    expect(err.message).toContain("NO se ejecutó");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("y queda anotado en el audit como bloqueo por monto", async () => {
    const fx = makeCtx({
      postResponse: EMIT_RESPONSE,
      config: { writeEnabled: true, maxMontos: { UYU: 100_000 } },
    });
    await dryRunThenExecute(fx, { comprobante: CARO });
    expect(fx.auditEntries.some((e) => e.outcome === "monto_excedido")).toBe(true);
  });

  it("el DRY-RUN lo anticipa en vez de dejar que la confirmación rebote", async () => {
    const fx = makeCtx({
      postResponse: EMIT_RESPONSE,
      config: { writeEnabled: true, maxMontos: { UYU: 100_000 } },
    });
    const dry = await handleEmitirComprobante({ comprobante: CARO }, fx.ctx);
    expect(sc(dry).mode).toBe("dry_run");
    expect((sc(dry).warnings as string[]).some((w) => /supera el tope/.test(w))).toBe(true);
  });

  it("una emisión por debajo del tope sigue pasando", async () => {
    const fx = makeCtx({
      postResponse: EMIT_RESPONSE,
      config: { writeEnabled: true, maxMontos: { UYU: 100_000 } },
    });
    const { exec, dry } = await dryRunThenExecute(fx, { comprobante: COMPROBANTE });
    expect((sc(dry).warnings as string[]).some((w) => /supera el tope/.test(w))).toBe(false);
    expect(sc(exec).mode).toBe("executed");
  });

  it("el tope es POR MONEDA también acá", async () => {
    // Un límite pensado en pesos aplicado a una factura en dólares frenaría
    // casi todo. Sin tope para USD, no se bloquea.
    const fx = makeCtx({
      postResponse: EMIT_RESPONSE,
      config: { writeEnabled: true, maxMontos: { UYU: 100_000 } },
    });
    const enDolares = { ...CARO, moneda: "USD", tasa_cambio: 40 };
    const { exec } = await dryRunThenExecute(fx, { comprobante: enDolares });
    expect(sc(exec).mode).toBe("executed");
  });

  it("sin topes configurados nada cambia", async () => {
    const fx = makeCtx({ postResponse: EMIT_RESPONSE, config: { writeEnabled: true } });
    const { exec } = await dryRunThenExecute(fx, { comprobante: CARO });
    expect(sc(exec).mode).toBe("executed");
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

describe("crear_cliente — dry-run / confirm", () => {
  // El endpoint recibe un objeto PLANO (no anidado como en la emisión de CFE).
  const CLIENTE_CON_RAZON = {
    tipo_documento: 2,
    documento: "217832560011",
    razon_social: "Empresa Test SRL",
    direccion: "Los Arces 7635",
    ciudad: "Montevideo",
    departamento: "Montevideo",
    pais: "UY",
  };

  it("dry-run retorna endpoint correcto /v2/clientes/crear", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente({ cliente: CLIENTE_CON_RAZON }, fx.ctx);
    expect(res.isError).toBeUndefined();
    expect(sc(res).mode).toBe("dry_run");
    expect(sc(res).endpoint).toBe("/v2/clientes/crear");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("confirm bloquea sin writeEnabled", async () => {
    const fx = makeCtx({ config: { writeEnabled: false } });
    const dry = await handleCrearCliente({ cliente: CLIENTE_CON_RAZON }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleCrearCliente(
      { cliente: CLIENTE_CON_RAZON, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("write_disabled");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  // El schema oficial solo exige tipo_documento, documento y pais. El "nombre
  // principal" según el tipo de documento se avisa, no se bloquea.
  it("avisa (sin bloquear) cuando un RUT no trae razon_social", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente(
      { cliente: { ...CLIENTE_CON_RAZON, razon_social: undefined } },
      fx.ctx,
    );
    expect(res.isError).toBeUndefined();
    expect((sc(res).warnings as string[]).some((w) => w.includes("razon_social"))).toBe(true);
  });

  it("avisa cuando un RUT usa nombre_fantasia como nombre principal", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente(
      {
        cliente: { ...CLIENTE_CON_RAZON, razon_social: undefined, nombre_fantasia: "Mi Negocio" },
      },
      fx.ctx,
    );
    expect(res.isError).toBeUndefined();
    expect((sc(res).warnings as string[]).some((w) => w.includes("razon_social"))).toBe(true);
  });

  // Estos SÍ son `required` en el schema oficial.
  it("rechaza un cliente sin pais", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente(
      { cliente: { ...CLIENTE_CON_RAZON, pais: undefined } },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
    expect(errorOf(res).message).toContain("pais");
  });

  it("rechaza un cliente sin documento", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente(
      { cliente: { ...CLIENTE_CON_RAZON, documento: undefined } },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
  });

  it("acepta una CI identificada con nombre_fantasia", async () => {
    const fx = makeCtx();
    const res = await handleCrearCliente(
      {
        cliente: {
          tipo_documento: 3,
          documento: "47348269",
          nombre_fantasia: "Martín Perez",
          direccion: "18 de Julio esquina Ejido",
          ciudad: "Montevideo",
          pais: "UY",
        },
      },
      fx.ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(sc(res).mode).toBe("dry_run");
  });
});

describe("cargar_producto — dry-run / confirm", () => {
  const PRODUCTO = {
    codigo: "P001",
    nombre: "Pelota",
    moneda: "UYU",
    precio: 200,
    indicador_facturacion: 3,
    es_servicio: false,
  };
  const PRODUCTO_RESPONSE = { id: 1, codigo: "P001" };

  it("dry-run retorna endpoint correcto /v2/productos/cargar", async () => {
    const fx = makeCtx();
    const res = await handleCargarProducto({ producto: PRODUCTO }, fx.ctx);
    expect(res.isError).toBeUndefined();
    expect(sc(res).mode).toBe("dry_run");
    expect(sc(res).endpoint).toBe("/v2/productos/cargar");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("confirm bloquea sin writeEnabled", async () => {
    const fx = makeCtx({ config: { writeEnabled: false } });
    const dry = await handleCargarProducto({ producto: PRODUCTO }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleCargarProducto(
      { producto: PRODUCTO, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("write_disabled");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("rateLimitClass es default (no dgi)", async () => {
    const fx = makeCtx({ postResponse: PRODUCTO_RESPONSE, config: { writeEnabled: true } });
    const dry = await handleCargarProducto({ producto: PRODUCTO }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    await handleCargarProducto({ producto: PRODUCTO, confirm: true, confirmation_token: token }, fx.ctx);
    expect(fx.postMock).toHaveBeenCalledOnce();
    expect(fx.postMock.mock.calls[0]![0].rateLimitClass).toBe("default");
  });
});

describe("crear_recibo — dry-run / confirm", () => {
  // La doc exige `cliente` (con documento y dirección) y `pago`.
  const RECIBO = {
    tipo_comprobante: 101,
    forma_pago: 1,
    sucursal: 6,
    moneda: "UYU",
    cliente: {
      tipo_documento: 3,
      documento: "52165030",
      nombre_fantasia: "Juan Pérez",
      sucursal: { pais: "UY", ciudad: "Montevideo", direccion: "Sarandí 420" },
    },
    referencias: [{ padre: 150448, total: 1830 }],
    pago: { fecha: "2021-05-27", monto: 1830, referencia: "Transferencia Itaú 2185" },
  };
  const RECIBO_RESPONSE = { id: 99, serie: "X", numero: "100" };

  it("rechaza un recibo sin cliente (Biller responde 422 cliente required)", async () => {
    const fx = makeCtx();
    const res = await handleCrearRecibo(
      { recibo: { ...RECIBO, cliente: undefined } },
      fx.ctx,
    );
    expect(res.isError).toBe(true);
  });

  it("avisa cuando el pago supera la suma de las referencias (Adelanto)", async () => {
    const fx = makeCtx();
    const res = await handleCrearRecibo(
      { recibo: { ...RECIBO, pago: { ...RECIBO.pago, monto: 2000 } } },
      fx.ctx,
    );
    expect(res.isError).toBeUndefined();
    expect((sc(res).warnings as string[]).some((w) => w.includes("Adelanto"))).toBe(true);
  });

  it("dry-run retorna endpoint correcto /v2/recibos/crear", async () => {
    const fx = makeCtx();
    const res = await handleCrearRecibo({ recibo: RECIBO }, fx.ctx);
    expect(res.isError).toBeUndefined();
    expect(sc(res).mode).toBe("dry_run");
    expect(sc(res).endpoint).toBe("/v2/recibos/crear");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("confirm bloquea sin writeEnabled", async () => {
    const fx = makeCtx({ config: { writeEnabled: false } });
    const dry = await handleCrearRecibo({ recibo: RECIBO }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    const exec = await handleCrearRecibo(
      { recibo: RECIBO, confirm: true, confirmation_token: token },
      fx.ctx,
    );
    expect(exec.isError).toBe(true);
    expect(errorOf(exec).kind).toBe("write_disabled");
    expect(fx.postMock).not.toHaveBeenCalled();
  });

  it("rateLimitClass es dgi", async () => {
    const fx = makeCtx({ postResponse: RECIBO_RESPONSE, config: { writeEnabled: true } });
    const dry = await handleCrearRecibo({ recibo: RECIBO }, fx.ctx);
    const token = sc(dry).confirmation_token as string;
    await handleCrearRecibo({ recibo: RECIBO, confirm: true, confirmation_token: token }, fx.ctx);
    expect(fx.postMock).toHaveBeenCalledOnce();
    expect(fx.postMock.mock.calls[0]![0].rateLimitClass).toBe("dgi");
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
