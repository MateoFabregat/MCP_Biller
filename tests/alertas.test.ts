import { describe, expect, it } from "vitest";
import { normalizeComprobanteEmitido } from "../src/biller/normalize.js";
import type { ComprobanteEmitido } from "../src/biller/types.js";
import { PATHS } from "../src/constants.js";
import {
  EMISION_TARDIA_DIAS_CRITICA,
  analizarCae,
  detectarEmisionTardia,
  detectarRachaSinFacturar,
  detectarRechazos,
  generarAlertas,
  parseCae,
} from "../src/services/alertas.js";
import { extraerVencimientoCertificado } from "../src/services/certificadoDgi.js";
import { handleAlertas } from "../src/tools/alertas.js";
import { hoyComoDateUy } from "../src/services/fechaUy.js";
import { makeCtx } from "./helpers.js";

const HOY = new Date("2026-07-27T12:00:00Z");

function dia(offset: number): string {
  return new Date(HOY.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

interface ComprobanteRaw {
  id?: number;
  tipo?: number;
  serie?: string;
  numero?: number;
  estado?: string | null;
  cae?: unknown;
  fecha_emision?: string;
  fecha_creacion?: string;
}

function comprobante(raw: ComprobanteRaw = {}): ComprobanteEmitido {
  return normalizeComprobanteEmitido({
    id: raw.id ?? 1,
    tipo_comprobante: raw.tipo ?? 111,
    serie: raw.serie ?? "A",
    numero: raw.numero ?? 100,
    moneda: "UYU",
    total: 1000,
    estado: raw.estado === undefined ? "Aceptado DGI" : raw.estado,
    fecha_emision: raw.fecha_emision ?? dia(-5),
    fecha_creacion: raw.fecha_creacion,
    cae: raw.cae ?? {
      numero: "76747726",
      serie: raw.serie ?? "A",
      inicio: 1,
      fin: 1_000_000,
      fecha_expiracion: dia(365),
    },
  });
}

describe("detectarRechazos", () => {
  it("agrupa por estado y marca crítico solo lo rechazado", () => {
    const res = detectarRechazos([
      comprobante({ id: 1, estado: "Aceptado DGI" }),
      comprobante({ id: 2, estado: "Rechazado DGI" }),
      comprobante({ id: 3, estado: "Sobre Rechazado DGI" }),
      comprobante({ id: 4, estado: "Pendiente DGI" }),
    ]);

    expect(res.conteo_total).toBe(3);
    const estados = Object.fromEntries(res.por_estado.map((e) => [e.estado, e.severidad]));
    expect(estados["Rechazado DGI"]).toBe("critica");
    expect(estados["Sobre Rechazado DGI"]).toBe("critica");
    expect(estados["Pendiente DGI"]).toBe("advertencia");
    // Lo crítico va primero.
    expect(res.por_estado[0]!.severidad).toBe("critica");
  });

  it("no trata el estado ausente como un rechazo", () => {
    const res = detectarRechazos([comprobante({ id: 1, estado: null })]);
    expect(res.conteo_total).toBe(0);
  });

  it("acota la cantidad de ejemplos por estado sin falsear el conteo", () => {
    const muchos = Array.from({ length: 30 }, (_, i) =>
      comprobante({ id: i, estado: "Rechazado DGI" }),
    );
    const res = detectarRechazos(muchos, { max_por_estado: 5 });
    expect(res.por_estado[0]!.conteo).toBe(30);
    expect(res.por_estado[0]!.comprobantes).toHaveLength(5);
  });
});

describe("parseCae / analizarCae", () => {
  it("trata el CAE vacío como ausente", () => {
    expect(parseCae({})).toBeNull();
    expect(parseCae(null)).toBeNull();
  });

  it("estima los números disponibles a partir del mayor número visto", () => {
    const res = analizarCae(
      [
        comprobante({ id: 1, numero: 900_000, cae: { numero: "C1", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: dia(200) } }),
        comprobante({ id: 2, numero: 950_000, cae: { numero: "C1", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: dia(200) } }),
      ],
      { hoy: HOY },
    );

    expect(res).toHaveLength(1);
    expect(res[0]!.ultimo_numero_usado).toBe(950_000);
    expect(res[0]!.disponibles_estimados).toBe(50_000);
    expect(res[0]!.porcentaje_disponible).toBeCloseTo(0.05, 3);
    // 5% restante -> crítico.
    expect(res[0]!.severidad).toBe("critica");
    expect(res[0]!.comprobantes_en_periodo).toBe(2);
  });

  it("avisa cuando quedan pocos números aunque el rango sea chico", () => {
    const res = analizarCae(
      [comprobante({ numero: 950, cae: { numero: "C2", serie: "B", inicio: 1, fin: 1000, fecha_expiracion: dia(300) } })],
      { hoy: HOY },
    );
    expect(res[0]!.disponibles_estimados).toBe(50);
    expect(res[0]!.severidad).toBe("critica");
    expect(res[0]!.motivos.join(" ")).toContain("números autorizados");
  });

  it("marca crítico el CAE ya vencido y el que vence pronto", () => {
    const vencido = analizarCae(
      [comprobante({ numero: 5, cae: { numero: "V", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: dia(-3) } })],
      { hoy: HOY },
    );
    expect(vencido[0]!.dias_para_expirar).toBe(-3);
    expect(vencido[0]!.severidad).toBe("critica");
    expect(vencido[0]!.motivos.join(" ")).toContain("venció");

    const pronto = analizarCae(
      [comprobante({ numero: 5, cae: { numero: "P", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: dia(10) } })],
      { hoy: HOY },
    );
    expect(pronto[0]!.severidad).toBe("critica");

    const aviso = analizarCae(
      [comprobante({ numero: 5, cae: { numero: "W", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: dia(40) } })],
      { hoy: HOY },
    );
    expect(aviso[0]!.severidad).toBe("advertencia");
  });

  it("no alerta cuando hay rango de sobra y la expiración está lejos", () => {
    const res = analizarCae([comprobante({ numero: 10 })], { hoy: HOY });
    expect(res[0]!.severidad).toBe("info");
    expect(res[0]!.motivos).toEqual([]);
  });

  it("separa CAEs distintos y no mezcla series", () => {
    const res = analizarCae(
      [
        comprobante({ id: 1, serie: "A", numero: 10, cae: { numero: "C1", serie: "A", inicio: 1, fin: 100, fecha_expiracion: dia(300) } }),
        comprobante({ id: 2, serie: "B", numero: 20, cae: { numero: "C2", serie: "B", inicio: 1, fin: 100, fecha_expiracion: dia(300) } }),
      ],
      { hoy: HOY },
    );
    expect(res).toHaveLength(2);
  });
});

describe("detectarEmisionTardia", () => {
  it("marca crítico un delta mayor a los días de EMISION_TARDIA_DIAS_CRITICA", () => {
    const res = detectarEmisionTardia([
      // Emitido hace 15 días, cargado hace 3: 12 días de atraso (> 10 -> crítico).
      comprobante({ id: 1, fecha_emision: dia(-15), fecha_creacion: `${dia(-3)} 10:00:00` }),
    ]);
    expect(res.conteo_total).toBe(1);
    const grupoCritico = res.por_severidad.find((g) => g.severidad === "critica");
    expect(grupoCritico).toBeDefined();
    expect(grupoCritico!.comprobantes[0]!.dias_de_atraso).toBeGreaterThan(EMISION_TARDIA_DIAS_CRITICA);
  });

  it("no marca como tardío un delta de 0 (mismo día) ni uno negativo (creado antes de emitirse)", () => {
    const mismoDia = detectarEmisionTardia([
      comprobante({ id: 1, fecha_emision: dia(-5), fecha_creacion: `${dia(-5)} 23:00:00` }),
    ]);
    expect(mismoDia.conteo_total).toBe(0);
    expect(mismoDia.conteo_emision_futura).toBe(0);

    const futura = detectarEmisionTardia([
      // Cargado 4 días ANTES de su propia fecha de emisión: no es tardío, es otra cosa.
      comprobante({ id: 2, fecha_emision: dia(-1), fecha_creacion: `${dia(-5)} 09:00:00` }),
    ]);
    expect(futura.conteo_total).toBe(0);
    expect(futura.conteo_emision_futura).toBe(1);
  });

  it("sin ambas fechas, no inventa un delta", () => {
    const res = detectarEmisionTardia([comprobante({ id: 1, fecha_emision: dia(-15) })]);
    expect(res.conteo_total).toBe(0);
    expect(res.conteo_emision_futura).toBe(0);
  });
});

describe("detectarRachaSinFacturar", () => {
  it("no alerta cuando la empresa factura con un patrón semanal regular (ej. todos los lunes)", () => {
    // Cuatro emisiones espaciadas exactamente 7 días, "hoy" cae 7 días después
    // de la última: el martes siguiente al lunes de facturación no debe alertar.
    const comprobantes = [-28, -21, -14, -7].map((offset, i) =>
      comprobante({ id: i, fecha_emision: dia(offset) }),
    );
    const res = detectarRachaSinFacturar(comprobantes, { hoy: HOY });
    expect(res).not.toBeNull();
    expect(res!.brecha_habitual_dias).toBe(7);
    expect(res!.racha_actual_dias).toBe(7);
    expect(res!.alerta).toBe(false);
  });

  it("alerta cuando factura todos los días y la racha actual se corta hace 10 días", () => {
    const comprobantes = Array.from({ length: 11 }, (_, i) =>
      comprobante({ id: i, fecha_emision: dia(-20 + i) }), // -20..-10, un día de por medio
    );
    const res = detectarRachaSinFacturar(comprobantes, { hoy: HOY });
    expect(res).not.toBeNull();
    expect(res!.brecha_habitual_dias).toBe(1);
    expect(res!.racha_actual_dias).toBe(10);
    expect(res!.alerta).toBe(true);
  });

  it("no inventa una racha si no hay comprobantes", () => {
    expect(detectarRachaSinFacturar([], { hoy: HOY })).toBeNull();
  });
});

describe("generarAlertas", () => {
  it("ordena por severidad y avisa que la estimación de CAE es optimista", () => {
    const res = generarAlertas(
      [
        comprobante({ id: 1, estado: "Pendiente DGI" }),
        comprobante({ id: 2, estado: "Rechazado DGI" }),
        // Emisión reciente para que la racha sin facturar no dispare acá: este
        // test es sobre rechazos/CAE, la racha se prueba aparte más abajo.
        comprobante({ id: 3, estado: "Aceptado DGI", fecha_emision: dia(0) }),
      ],
      { hoy: HOY },
    );

    expect(res.alertas[0]!.severidad).toBe("critica");
    expect(res.alertas[0]!.tipo).toBe("rechazo_dgi");
    expect(res.conteo_por_severidad.critica).toBe(1);
    expect(res.conteo_por_severidad.advertencia).toBe(1);
    expect(res.warnings.some((w) => w.includes("OPTIMISTA"))).toBe(true);
  });

  it("sin comprobantes no inventa alertas y lo dice", () => {
    const res = generarAlertas([], { hoy: HOY });
    expect(res.alertas).toEqual([]);
    expect(res.warnings.some((w) => w.includes("No hay comprobantes"))).toBe(true);
  });

  it("integra la racha sin facturar como alerta cuando corresponde", () => {
    const comprobantes = Array.from({ length: 11 }, (_, i) =>
      comprobante({ id: i, fecha_emision: dia(-20 + i), estado: "Aceptado DGI" }),
    );
    const res = generarAlertas(comprobantes, { hoy: HOY });
    const alertaRacha = res.alertas.find((a) => a.tipo === "sin_facturar");
    expect(alertaRacha).toBeDefined();
    expect(alertaRacha!.severidad).toBe("advertencia");
    expect(res.racha_sin_facturar?.alerta).toBe(true);
  });
});

describe("tool biller_alertas_operativas", () => {
  it("devuelve las alertas del período y filtra por severidad", async () => {
    const hoyReal = hoyComoDateUy();
    const diaReal = (offset: number): string =>
      new Date(hoyReal.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

    const { ctx } = makeCtx({
      response: [
        {
          id: 1,
          tipo_comprobante: 111,
          serie: "A",
          numero: 10,
          moneda: "UYU",
          total: 1000,
          estado: "Rechazado DGI",
          fecha_emision: diaReal(-2),
          cae: { numero: "C1", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: diaReal(400) },
        },
        {
          id: 2,
          tipo_comprobante: 111,
          serie: "A",
          numero: 11,
          moneda: "UYU",
          total: 500,
          estado: "Pendiente DGI",
          fecha_emision: diaReal(-1),
          cae: { numero: "C1", serie: "A", inicio: 1, fin: 1_000_000, fecha_expiracion: diaReal(400) },
        },
      ],
    });

    const todas = await handleAlertas({ periodo: "ultimos_7_dias" }, ctx);
    const out = todas.structuredContent as Record<string, unknown>;
    expect(todas.isError).toBeUndefined();
    expect((out.alertas as unknown[]).length).toBe(2);
    expect((out.rechazos as { conteo_total: number }).conteo_total).toBe(2);

    const soloCriticas = await handleAlertas(
      { periodo: "ultimos_7_dias", severidad_minima: "critica" },
      ctx,
    );
    const outCriticas = soloCriticas.structuredContent as Record<string, unknown>;
    expect((outCriticas.alertas as Array<{ severidad: string }>).every((a) => a.severidad === "critica")).toBe(true);
    expect((outCriticas.alertas as unknown[]).length).toBe(1);
  });

  it("rechaza un período que no se puede interpretar", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handleAlertas({ periodo: "el mes que viene" }, ctx);
    expect(res.isError).toBe(true);
  });

  it("certificado vencido: genera una alerta crítica sin romper el resto de las alertas", async () => {
    const { ctx } = makeCtx({
      config: { defaultEmpresaRut: "210000000015" },
      impl: (opts) => {
        if (opts.path === PATHS.dgiCertificado) {
          // Fixture INVENTADA: la forma real no está documentada, pero acá sí
          // trae un campo reconocible por nombre.
          return { Flag: "OK", RUT: "210000000015", RespuestaOK: { FechaVencimiento: "2020-01-01" } };
        }
        return [];
      },
    });

    const res = await handleAlertas({ periodo: "ultimos_7_dias" }, ctx);
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as Record<string, unknown>;
    const certificado = out.certificado_dgi as {
      consultado: boolean;
      vencimiento: { fecha: string | null; campo: string | null };
    };
    expect(certificado.consultado).toBe(true);
    expect(certificado.vencimiento.fecha).toBe("2020-01-01");
    expect(certificado.vencimiento.campo).toBe("FechaVencimiento");

    const alertaCert = (out.alertas as Array<{ tipo: string; severidad: string }>).find(
      (al) => al.tipo === "certificado_vencido",
    );
    expect(alertaCert).toBeDefined();
    expect(alertaCert!.severidad).toBe("critica");
    // El conteo por severidad tiene que reflejar también la alerta del
    // certificado, no solo lo que ya traía generarAlertas.
    expect((out.conteo_por_severidad as Record<string, number>).critica).toBe(1);
  });

  it("certificado sin fecha detectable: no inventa un vencimiento y lista los campos inspeccionados", async () => {
    const { ctx } = makeCtx({
      config: { defaultEmpresaRut: "210000000015" },
      impl: (opts) => {
        if (opts.path === PATHS.dgiCertificado) {
          // Ningún campo de esta fixture matchea /venc|expir|hasta|fin|valid/i.
          return { Flag: "OK", RUT: "210000000015", RespuestaOK: { Estado: "Activo", Serie: "AB123" } };
        }
        return [
          {
            id: 1,
            tipo_comprobante: 111,
            serie: "A",
            numero: 1,
            moneda: "UYU",
            total: 100,
            estado: "Rechazado DGI",
            fecha_emision: hoyComoDateUy().toISOString().slice(0, 10),
            cae: {},
          },
        ];
      },
    });

    const res = await handleAlertas({ periodo: "ultimos_7_dias" }, ctx);
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as Record<string, unknown>;

    const certificado = out.certificado_dgi as {
      consultado: boolean;
      vencimiento: { fecha: string | null; candidatos: string[] };
    };
    expect(certificado.consultado).toBe(true);
    expect(certificado.vencimiento.fecha).toBeNull();
    expect(certificado.vencimiento.candidatos.length).toBeGreaterThan(0);
    expect(
      (out.warnings as string[]).some((w) => w.includes("No se pudo determinar la fecha de vencimiento")),
    ).toBe(true);

    // El resto de las alertas (el rechazo DGI) sigue presente: el certificado
    // "no sé" no tira abajo la tool.
    expect((out.rechazos as { conteo_total: number }).conteo_total).toBe(1);
  });

  it("si la consulta del certificado falla, la tool igual devuelve el resto de las alertas", async () => {
    const { ctx } = makeCtx({
      config: { defaultEmpresaRut: "210000000015" },
      impl: (opts) => {
        if (opts.path === PATHS.dgiCertificado) {
          throw new Error("timeout simulado");
        }
        return [
          {
            id: 1,
            tipo_comprobante: 111,
            serie: "A",
            numero: 1,
            moneda: "UYU",
            total: 100,
            estado: "Rechazado DGI",
            fecha_emision: hoyComoDateUy().toISOString().slice(0, 10),
            cae: {},
          },
        ];
      },
    });

    const res = await handleAlertas({ periodo: "ultimos_7_dias" }, ctx);
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as Record<string, unknown>;

    expect((out.rechazos as { conteo_total: number }).conteo_total).toBe(1);
    const certificado = out.certificado_dgi as { consultado: boolean; error: string | null };
    expect(certificado.consultado).toBe(false);
    expect(certificado.error).not.toBeNull();
    expect(
      (out.warnings as string[]).some((w) => w.includes("No se pudo consultar el certificado único de DGI")),
    ).toBe(true);
  });

  it("sin BILLER_DEFAULT_EMPRESA_RUT configurado, no consulta el certificado y avisa qué falta", async () => {
    const { ctx } = makeCtx({ response: [] });
    const res = await handleAlertas({ periodo: "ultimos_7_dias" }, ctx);
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as Record<string, unknown>;
    const certificado = out.certificado_dgi as { consultado: boolean };
    expect(certificado.consultado).toBe(false);
    expect((out.warnings as string[]).some((w) => w.includes("BILLER_DEFAULT_EMPRESA_RUT"))).toBe(true);
  });
});

describe("extraerVencimientoCertificado", () => {
  it("encuentra la fecha en un campo cuyo nombre matchea el patrón de vencimiento", () => {
    const res = extraerVencimientoCertificado({
      Flag: "OK",
      FechaVencimiento: "2026-12-31",
      Serie: "12345",
    });
    expect(res.fecha).toBe("2026-12-31");
    expect(res.campo).toBe("FechaVencimiento");
  });

  it("busca recursivamente en objetos anidados", () => {
    const res = extraerVencimientoCertificado({
      Flag: "OK",
      Detalle: { Estado: "Activo", ValidoHasta: "2027-01-15T00:00:00" },
    });
    expect(res.fecha).toBe("2027-01-15");
    expect(res.campo).toBe("ValidoHasta");
  });

  it("si no encuentra ninguna fecha, devuelve fecha null y lista los campos inspeccionados", () => {
    const res = extraerVencimientoCertificado({
      Flag: "OK",
      Detalle: { Estado: "Activo", Serie: "12345" },
    });
    expect(res.fecha).toBeNull();
    expect(res.campo).toBeNull();
    expect(res.candidatos).toEqual(expect.arrayContaining(["Flag", "Detalle", "Estado", "Serie"]));
  });

  it("no revienta con null, undefined o valores que no son objetos", () => {
    expect(extraerVencimientoCertificado(null)).toEqual({ fecha: null, campo: null, candidatos: [] });
    expect(extraerVencimientoCertificado(undefined)).toEqual({ fecha: null, campo: null, candidatos: [] });
    expect(extraerVencimientoCertificado("texto plano")).toEqual({
      fecha: null,
      campo: null,
      candidatos: [],
    });
  });
});
