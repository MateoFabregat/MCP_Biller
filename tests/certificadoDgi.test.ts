import { describe, expect, it } from "vitest";
import { normalizeDgiCertificado } from "../src/biller/normalize.js";
import { handleAlertas } from "../src/tools/alertas.js";
import { hoyComoDateUy } from "../src/services/fechaUy.js";
import { makeCtx } from "./helpers.js";

/**
 * Respuesta REAL de GET /v2/dgi/empresas/certificado-unico contra
 * test.biller.uy (2026-07-28). Es PLANA: no trae `Flag` ni `RespuestaOK`, al
 * revés de lo que muestra el ejemplo del OpenAPI. Las fechas vienen como
 * whitespace puro cuando no hay certificado emitido.
 */
const CERT_REAL_SIN_CERTIFICADO = {
  RUT: "219999830019",
  Denominacion: "DGI RUC PRUEBA CEDE",
  DomicilioFiscal: "FERNANDEZ CRESPO AVDA. DANIEL 1534 - MONTEVIDEO",
  TipoContribuyente: "CEDE",
  Estado: "NO existe Certificado de Vigencia Anual",
  Emision: "\n\t\t\t\t\t",
  Vencimiento: "\n\t\t\t\t\t",
};

/** Forma que documenta el OpenAPI: envuelta en Flag + RespuestaOK. */
const CERT_DOCUMENTADO = {
  Flag: "OK",
  RUT: "210475730011",
  RespuestaOK: {
    Numero: "214477082",
    Denominacion: "ADMINISTRACION NACIONAL DE COMBUSTIBLES ALCOHOL Y PORTLAND",
    TipoContribuyente: "GRANDES CONTRIBUYENTES",
    Estado: "Certificado de Vigencia Anual Habilitado.",
    Emision: "2021-05-21",
    Vencimiento: "2022-05-31",
  },
};

describe("normalizeDgiCertificado", () => {
  // Este es el caso que el normalizador perdía entero: leía solo RespuestaOK y
  // devolvía certificado: null sobre una respuesta que sí traía datos.
  it("lee la respuesta REAL, que viene plana y sin envoltura", () => {
    const c = normalizeDgiCertificado(CERT_REAL_SIN_CERTIFICADO);
    expect(c.rut).toBe("219999830019");
    expect(c.estado).toBe("NO existe Certificado de Vigencia Anual");
    expect(c.denominacion).toContain("DGI RUC PRUEBA");
    expect(c.tipo_contribuyente).toBe("CEDE");
    expect(c.certificado).not.toBeNull();
  });

  it("las fechas de whitespace puro no son fechas", () => {
    const c = normalizeDgiCertificado(CERT_REAL_SIN_CERTIFICADO);
    expect(c.vencimiento).toBeNull();
    expect(c.emision).toBeNull();
  });

  it("sigue leyendo la forma envuelta que documenta el OpenAPI", () => {
    const c = normalizeDgiCertificado(CERT_DOCUMENTADO);
    expect(c.flag).toBe("OK");
    expect(c.rut).toBe("210475730011");
    expect(c.vencimiento).toBe("2022-05-31");
    expect(c.estado).toContain("Habilitado");
  });

  it("una respuesta vacía no rompe", () => {
    const c = normalizeDgiCertificado({});
    expect(c.rut).toBeNull();
    expect(c.vencimiento).toBeNull();
  });
});

describe("alerta de certificado — los tres estados", () => {
  const ctxCon = (certResponse: unknown) =>
    makeCtx({
      config: { defaultEmpresaRut: "219999830019" },
      impl: (o) => (o.path.includes("certificado") ? certResponse : []),
    });

  it("'NO existe certificado' es crítico y NO se reporta como vencimiento", async () => {
    const { ctx } = ctxCon(CERT_REAL_SIN_CERTIFICADO);
    const res = await handleAlertas({ periodo: "2026-07", severidad_minima: "critica" }, ctx);
    const alertas = res.structuredContent!.alertas as Array<{ tipo: string; detalle: string }>;
    const cert = alertas.find((a) => a.tipo === "certificado_vencido")!;

    expect(cert).toBeDefined();
    expect(cert.detalle).toMatch(/no está emitido|tramitarlo/i);
    // No hay fecha que mirar: la alerta no debe hablar de días para vencer.
    const estado = res.structuredContent!.certificado_dgi as { dias_para_expirar: number | null };
    expect(estado.dias_para_expirar).toBeNull();
  });

  it("un certificado vigente y lejos de vencer no genera alerta", async () => {
    const dentroDeUnAnio = new Date(hoyComoDateUy().getTime() + 300 * 86_400_000).toISOString().slice(0, 10);
    const { ctx } = ctxCon({
      ...CERT_REAL_SIN_CERTIFICADO,
      Estado: "Certificado de Vigencia Anual Habilitado.",
      Vencimiento: dentroDeUnAnio,
    });
    const res = await handleAlertas({ periodo: "2026-07" }, ctx);
    const alertas = res.structuredContent!.alertas as Array<{ tipo: string }>;
    expect(alertas.some((a) => a.tipo.startsWith("certificado"))).toBe(false);
  });

  it("un certificado por vencer usa el campo Vencimiento explícito", async () => {
    const enDiezDias = new Date(hoyComoDateUy().getTime() + 10 * 86_400_000).toISOString().slice(0, 10);
    const { ctx } = ctxCon({
      ...CERT_REAL_SIN_CERTIFICADO,
      Estado: "Certificado de Vigencia Anual Habilitado.",
      Vencimiento: enDiezDias,
    });
    const res = await handleAlertas({ periodo: "2026-07" }, ctx);
    const estado = res.structuredContent!.certificado_dgi as {
      vencimiento: { campo: string | null };
      dias_para_expirar: number | null;
    };
    expect(estado.vencimiento.campo).toBe("Vencimiento");
    expect(estado.dias_para_expirar).toBe(10);
  });
});
