// =============================================================================
// Cálculo local de totales de un CFE (preview de emisión).
// =============================================================================

import { describe, expect, it } from "vitest";
import { ComprobanteBodySchema } from "../src/biller/cfeSchema.js";
import { calcularTotales, formatearTotales } from "../src/services/calcularTotales.js";

const parse = (input: Record<string, unknown>) => ComprobanteBodySchema.parse(input);

const BASE = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
};

describe("calcularTotales", () => {
  it("suma IVA a la tasa básica cuando montos_brutos es falso", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        montos_brutos: 0,
        items: [{ cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 }],
      }),
    );
    expect(t.subtotal).toBe(200);
    expect(t.total_iva).toBe(44); // 200 * 22%
    expect(t.total).toBe(244);
    expect(t.iva_por_tasa["22"]).toBe(44);
    expect(t.exacto).toBe(true);
  });

  it("desagrega el IVA hacia atrás cuando montos_brutos es verdadero", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        montos_brutos: 1,
        items: [{ cantidad: 1, concepto: "Pelota", precio: 244, indicador_facturacion: 3 }],
      }),
    );
    expect(t.total).toBe(244); // el precio ya incluía IVA
    expect(t.subtotal).toBe(200);
    expect(t.total_iva).toBe(44);
    expect(t.supuestos.some((s) => /montos_brutos/.test(s))).toBe(true);
  });

  it("aplica la tasa mínima (10%) al indicador 2", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 2 }] }),
    );
    expect(t.total_iva).toBe(10);
    expect(t.total).toBe(110);
  });

  it("no cobra IVA sobre ítems exentos", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 1 }] }),
    );
    expect(t.total_iva).toBe(0);
    expect(t.total).toBe(100);
  });

  it("multiplica por cantidad", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 3, concepto: "X", precio: 100, indicador_facturacion: 1 }] }),
    );
    expect(t.total).toBe(300);
  });

  it("aplica descuentos y recargos de ítem", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          // 1000 - 100 = 900
          { cantidad: 1, concepto: "A", precio: 1000, indicador_facturacion: 1, descuento_tipo: "$", descuento_cantidad: 100 },
          // 2*100 = 200 + 10% = 220
          { cantidad: 2, concepto: "B", precio: 100, indicador_facturacion: 1, recargo_tipo: "%", recargo_cantidad: 10 },
        ],
      }),
    );
    expect(t.subtotal).toBe(1120);
  });

  it("aplica descuentos globales sobre los ítems del mismo indicador", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [{ cantidad: 1, concepto: "X", precio: 1000, indicador_facturacion: 1 }],
        descuentosRecargos: [
          { es_recargo: false, desc_rec_tipo: "%", glosa: "Promo", valor: 10, indicador_facturacion: 1 },
        ],
      }),
    );
    expect(t.ajustes_globales).toBe(-100);
    expect(t.subtotal).toBe(900);
  });

  it("marca el total como inexacto ante una tasa que no puede determinar", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 100, indicador_facturacion: 4 }] }),
    );
    expect(t.exacto).toBe(false);
    expect(t.advertencias.some((a) => /no se puede\s+determinar/.test(a))).toBe(true);
  });

  it("excluye del total los ítems no facturables", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          { cantidad: 1, concepto: "Vendido", precio: 100, indicador_facturacion: 1 },
          { cantidad: 1, concepto: "No facturable", precio: 999, indicador_facturacion: 6 },
        ],
      }),
    );
    expect(t.total).toBe(100);
    expect(t.lineas.find((l) => l.concepto === "No facturable")!.aporta_al_total).toBe(false);
  });

  it("calcula las retenciones aparte, sin sumarlas al total", () => {
    const t = calcularTotales(
      parse({
        ...BASE,
        items: [
          {
            cantidad: 1,
            concepto: "X",
            precio: 100,
            indicador_facturacion: 1,
            indicador_agente_responsable: "A",
            retencionesPercepciones: [{ codigo: 1145143, tasa: 10, monto_sujeto: 400 }],
          },
        ],
      }),
    );
    expect(t.total_retenciones_percepciones).toBe(40); // 10% de 400
    expect(t.total).toBe(100); // no se suma
  });

  it("formatea una línea legible para la confirmación", () => {
    const t = calcularTotales(
      parse({ ...BASE, items: [{ cantidad: 1, concepto: "X", precio: 200, indicador_facturacion: 3 }] }),
    );
    const texto = formatearTotales(t);
    // El total sigue estando; lo que cambió es CÓMO se escribe. Antes salía
    // "UYU 244" (el símbolo ISO y el número crudo de JavaScript); ahora sale a
    // la uruguaya, que es la forma en que el usuario puede verificarlo.
    expect(texto).toContain("$244");
    expect(texto).toContain("TOTAL");
  });
});

// =============================================================================
// EL PREVIEW.
//
// Es lo único que el humano lee antes de que un CFE exista ante DGI. La
// propiedad que se prueba acá no es estética: que TODO lo que se va a emitir —
// las líneas, el desglose de IVA, el total y los supuestos que el sistema
// completó solo— esté escrito en el mensaje, y escrito como se escriben los
// números en Uruguay.
// =============================================================================

describe("el preview de confirmación", () => {
  const DOS_BOLSAS = parse({
    ...BASE,
    montos_brutos: 1,
    items: [
      { cantidad: 2, concepto: "bolsas de portland", precio: 6500, indicador_facturacion: 3 },
    ],
  });

  it("lista los ítems con cantidad, concepto e importe de línea", () => {
    const texto = formatearTotales(calcularTotales(DOS_BOLSAS));
    expect(texto).toContain("2 × bolsas de portland");
    // El error típico no es el total: es la línea (dos bolsas en vez de veinte,
    // el precio del otro producto). Sin las líneas no hay nada que verificar.
    expect(texto).toContain("$13.000");
  });

  it("los números van a la uruguaya: punto de miles, coma decimal", () => {
    const texto = formatearTotales(calcularTotales(DOS_BOLSAS));
    // 13.000 con IVA incluido al 22%: neto 10.655,74 + IVA 2.344,26.
    expect(texto).toContain("$10.655,74");
    expect(texto).toContain("$2.344,26");
    // Y NINGÚN número crudo de JavaScript: "10655.74" es el formato que hace
    // que el usuario no pueda verificar lo que está aprobando.
    expect(texto).not.toContain("10655.74");
    expect(texto).not.toContain("2344.26");
  });

  it("desglosa el IVA por tasa y cierra con el TOTAL", () => {
    const texto = formatearTotales(calcularTotales(DOS_BOLSAS));
    expect(texto).toContain("Neto");
    expect(texto).toContain("IVA 22%");
    expect(texto.split("\n").some((l) => l.startsWith("TOTAL"))).toBe(true);
  });

  it("la línea de supuestos dice fecha, forma de pago y criterio de IVA", () => {
    // CADA DEFAULT QUE EL FLUJO DEJÓ DE PREGUNTAR TIENE QUE APARECER ACÁ. Un
    // default que el usuario no ve no es un default: es una suposición nuestra
    // impresa en un documento fiscal.
    const texto = formatearTotales(calcularTotales(DOS_BOLSAS), {
      fecha_emision: "26/08/2026",
      forma_pago: 1,
      montos_brutos: true,
      hoy: "26/08/2026",
    });
    expect(texto).toContain("Hoy 26/08/2026 · Contado · precios con IVA incluido");
  });

  it("una fecha que NO es hoy se muestra sin el 'Hoy' adelante", () => {
    // Es la forma más rápida de que alguien detecte que está por emitir un
    // comprobante con la fecha equivocada.
    const texto = formatearTotales(calcularTotales(DOS_BOLSAS), {
      fecha_emision: "20/08/2026",
      forma_pago: 1,
      hoy: "26/08/2026",
    });
    expect(texto).toContain("20/08/2026");
    expect(texto).not.toContain("Hoy");
  });

  it("a crédito dice crédito, y con vencimiento lo dice también", () => {
    const sinVto = formatearTotales(calcularTotales(DOS_BOLSAS), { forma_pago: 2 });
    expect(sinVto).toContain("Crédito");

    const conVto = formatearTotales(calcularTotales(DOS_BOLSAS), {
      forma_pago: 2,
      fecha_vencimiento: "25/09/2026",
    });
    expect(conVto).toContain("Crédito, vence 25/09/2026");
  });

  it('"IVA sumado aparte" y "con IVA incluido" son mensajes distintos', () => {
    // Es la diferencia entre facturar $13.000 y $15.860. Si el preview no lo
    // dice, el usuario no tiene cómo detectar que nos equivocamos.
    const brutos = formatearTotales(calcularTotales(DOS_BOLSAS), { montos_brutos: true });
    expect(brutos).toContain("precios con IVA incluido");

    const netos = formatearTotales(
      calcularTotales(parse({ ...BASE, montos_brutos: 0, items: DOS_BOLSAS.items })),
      { montos_brutos: false },
    );
    expect(netos).toContain("IVA sumado aparte");
    expect(netos).toContain("$15.860");
  });

  it("en dólares los importes salen con U$S", () => {
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          moneda: "USD",
          montos_brutos: 1,
          items: [{ cantidad: 1, concepto: "Servicio", precio: 100, indicador_facturacion: 3 }],
        }),
      ),
    );
    expect(texto).toContain("U$S100");
  });

  it("entra en los 1024 chars del cuerpo aunque el comprobante tenga veinte líneas", () => {
    // El límite es el de WhatsApp (LIMITES_INTERACTIVO.cuerpo). Si el mensaje se
    // trunca, lo que se pierde es el final — o sea el TOTAL y los supuestos.
    const muchos = Array.from({ length: 20 }, (_, i) => ({
      cantidad: 3,
      concepto: `Producto con un nombre bastante largo número ${i}`,
      precio: 1234.56,
      indicador_facturacion: 3,
    }));
    const texto = formatearTotales(
      calcularTotales(parse({ ...BASE, montos_brutos: 1, items: muchos })),
      { fecha_emision: "26/08/2026", forma_pago: 1, montos_brutos: true, hoy: "26/08/2026" },
    );
    expect(texto.length).toBeLessThan(1024);
    // Y lo que se recorta se DECLARA: un preview que muestra 8 de 20 líneas sin
    // decirlo hace pensar que el comprobante tiene 8.
    expect(texto).toContain("y 12 ítems más");
    expect(texto).toContain("TOTAL");
    expect(texto).toContain("Hoy 26/08/2026");
  });

  it("un ítem que no aporta al total lo dice en vez de mostrar su importe", () => {
    // Indicador 5 = entrega gratuita. Mostrar su precio sin aclararlo haría
    // parecer que el total está mal sumado.
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          items: [
            { cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 },
            { cantidad: 1, concepto: "Muestra", precio: 500, indicador_facturacion: 5 },
          ],
        }),
      ),
    );
    expect(texto).toContain("sin cargo");
    expect(texto).not.toContain("$500");
  });
});

// =============================================================================
// FISCAL-3 y FISCAL-6: lo que el preview callaba.
//
// Dos silencios distintos y los dos caros:
//
//   · `montos_brutos` sin valor no producía NINGUNA línea de supuestos. Y es
//     justo el caso en que la API asume precios netos y suma el 22%: el
//     silencio ya era una respuesta, y era la que más plata mueve.
//   · Los ajustes globales, las retenciones y las advertencias no se imprimían.
//     Un descuento del 10% dejaba $1.300 invisibles entre las líneas y el total.
// =============================================================================

describe("el preview no se calla lo que cambia el número", () => {
  const DOS_BOLSAS_NETO = {
    ...BASE,
    montos_brutos: 0,
    items: [
      { cantidad: 2, concepto: "bolsas de portland", precio: 6500, indicador_facturacion: 3 },
    ],
  };

  it("montos_brutos SIN VALOR se declara: la API asume netos y suma el IVA", () => {
    // El caso del hallazgo: antes, `undefined` no escribía nada.
    const texto = formatearTotales(calcularTotales(parse(DOS_BOLSAS_NETO)), {
      fecha_emision: "26/08/2026",
      forma_pago: 1,
      hoy: "26/08/2026",
    });
    expect(texto).toContain("IVA sumado aparte (la API asume precios netos)");
  });

  it("y con valor explícito NO agrega el paréntesis: son cosas distintas", () => {
    // "el usuario dijo que van netos" y "nadie dijo nada y la API los toma
    // netos" llevan al mismo número y no son la misma afirmación.
    const texto = formatearTotales(calcularTotales(parse(DOS_BOLSAS_NETO)), {
      montos_brutos: false,
    });
    expect(texto).toContain("IVA sumado aparte");
    expect(texto).not.toContain("la API asume");
  });

  it("un descuento global del 10% aparece como FILA, no como diferencia", () => {
    const cuerpo = parse({
      ...BASE,
      montos_brutos: 0,
      items: [
        { cantidad: 2, concepto: "bolsas de portland", precio: 6500, indicador_facturacion: 3 },
      ],
      descuentosRecargos: [
        { indicador_facturacion: 3, es_recargo: false, desc_rec_tipo: "%", valor: 10, glosa: "Cliente frecuente" },
      ],
    });
    const t = calcularTotales(cuerpo);
    const texto = formatearTotales(t, { montos_brutos: false });

    // 13.000 de neto, 10% = 1.300 de descuento.
    expect(t.ajustes_globales).toBe(-1300);
    expect(texto).toContain("Descuento 10%");
    expect(texto).toContain("−$1.300");
    // El "Neto" que se imprime es el de ANTES del ajuste: si fuera el de
    // después, la fila del descuento lo estaría restando dos veces a la vista.
    expect(texto).toContain("$13.000");
    // Y el TOTAL cierra: 11.700 + 22% = 14.274.
    expect(texto).toContain("$14.274");
  });

  it("un recargo global se distingue de un descuento por el signo", () => {
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          montos_brutos: 0,
          items: [{ cantidad: 1, concepto: "Servicio", precio: 1000, indicador_facturacion: 3 }],
          descuentosRecargos: [
            { indicador_facturacion: 3, es_recargo: true, desc_rec_tipo: "%", valor: 5 },
          ],
        }),
      ),
      { montos_brutos: false },
    );
    expect(texto).toContain("Recargo 5%");
    expect(texto).toContain("+$50");
  });

  it("las retenciones se muestran APARTE y se aclara que no suman", () => {
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          montos_brutos: 0,
          items: [{ cantidad: 1, concepto: "Servicio", precio: 1000, indicador_facturacion: 3 }],
          retencionesPercepciones: [{ codigo: "2183", tasa: 10, monto_sujeto: 1000, valor: 100 }],
        }),
      ),
      { montos_brutos: false },
    );
    expect(texto).toContain("Retenciones (aparte)");
    expect(texto).toContain("no están sumadas en el TOTAL");
  });

  it("los ítems sin cargo se declaran además de mostrarse como línea", () => {
    // La línea "sin cargo" solo se ve si el ítem entra en las 8 visibles. El
    // aviso vale para el comprobante entero.
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          montos_brutos: 0,
          items: [
            { cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 },
            { cantidad: 1, concepto: "Muestra", precio: 500, indicador_facturacion: 5 },
          ],
        }),
      ),
      { montos_brutos: false },
    );
    expect(texto).toContain("no suman al total");
  });

  it("una tasa que no se pudo determinar sale escrita en el preview", () => {
    // `advertencias` existía y no se imprimía: el TOTAL decía "(aprox.)" y en
    // ningún lado se explicaba por qué.
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          montos_brutos: 0,
          items: [{ cantidad: 1, concepto: "Otra tasa", precio: 1000, indicador_facturacion: 4 }],
        }),
      ),
      { montos_brutos: false },
    );
    expect(texto).toContain("TOTAL (aprox.)");
    expect(texto).toContain("⚠️");
    expect(texto).toContain("no se puede");
  });

  it("con todo junto sigue entrando en el cuerpo de WhatsApp", () => {
    // Si el mensaje se pasa de largo, lo que se corta es el final — o sea el
    // TOTAL. Lo que se cae son los avisos, y se declara cuántos.
    const texto = formatearTotales(
      calcularTotales(
        parse({
          ...BASE,
          montos_brutos: 0,
          items: Array.from({ length: 20 }, (_, i) => ({
            cantidad: 3,
            concepto: `Producto con un nombre bastante largo número ${i}`,
            precio: 1234.56,
            indicador_facturacion: i % 3 === 0 ? 4 : 3,
          })),
          descuentosRecargos: [
            { indicador_facturacion: 3, es_recargo: false, desc_rec_tipo: "%", valor: 10 },
          ],
          retencionesPercepciones: [{ codigo: "2183", tasa: 10, monto_sujeto: 1000, valor: 100 }],
        }),
      ),
      { fecha_emision: "26/08/2026", forma_pago: 1, montos_brutos: false, hoy: "26/08/2026" },
    );
    expect(texto.length).toBeLessThan(1024);
    // Los números NO se recortan nunca: lo que se cae es la letra chica.
    expect(texto).toContain("TOTAL");
    expect(texto).toContain("Descuento 10%");
    expect(texto).toContain("Hoy 26/08/2026");
  });
});
