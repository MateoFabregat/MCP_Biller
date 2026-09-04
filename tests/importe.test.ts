// =============================================================================
// Leer importes escritos por una persona.
//
// El test que resume el módulo entero es el primero: `Number("6.500")` es 6.5, y
// en Uruguay "6.500" son seis mil quinientos. Todo lo demás son las variantes
// que aparecen alrededor de ese caso.
//
// Los tests de `ambiguo: true` son tan importantes como los de valor: marcan los
// casos donde el módulo se niega a decidir en silencio. Si alguien "arregla" uno
// de esos poniendo ambiguo en false, el eco de confirmación desaparece y el
// error vuelve a ser invisible hasta después de emitir.
// =============================================================================

import { describe, expect, it } from "vitest";
import { formatearUy, parsearCantidad, parsearImporte } from "../src/services/importe.js";

describe("el punto de miles uruguayo", () => {
  it('"6.500" son seis mil quinientos, no seis con cinco', () => {
    // Number("6.500") === 6.5. Este test es el módulo entero.
    const r = parsearImporte("6.500");
    expect(r.valor).toBe(6500);
    expect(r.ambiguo).toBe(false);
  });

  it.each([
    ["6500", 6500],
    ["6.500", 6500],
    ["1.234.567", 1234567],
    ["$ 6.500", 6500],
    ["$6500", 6500],
    ["120,50", 120.5],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["  850  ", 850],
  ])("%s -> %d", (texto, esperado) => {
    expect(parsearImporte(texto).valor).toBe(esperado);
  });
});

describe("lo genuinamente ambiguo se marca, no se adivina", () => {
  it('"6.50" puede ser 6,50 o 6.500: se elige uno y se avisa', () => {
    const r = parsearImporte("6.50");
    expect(r.valor).toBe(6.5);
    expect(r.ambiguo).toBe(true);
    expect(r.detalle).toContain("CONFIRMALO");
  });

  it('"6,500" con coma de miles también', () => {
    const r = parsearImporte("6,500");
    expect(r.valor).toBe(6500);
    expect(r.ambiguo).toBe(true);
  });

  it("el detalle dice las DOS lecturas, para poder preguntarlas", () => {
    expect(parsearImporte("6.50").detalle).toContain("650");
  });

  it("lo no ambiguo NO se marca: un eco de más también cansa", () => {
    expect(parsearImporte("6500").ambiguo).toBe(false);
    expect(parsearImporte("1.234,56").ambiguo).toBe(false);
  });
});

describe("moneda e IVA que vienen en el mismo texto", () => {
  it.each([
    ["U$S 120", "USD"],
    ["us$ 120", "USD"],
    ["120 dólares", "USD"],
    ["$ 6.500", "UYU"],
    ["6500 pesos", "UYU"],
    ["6500", null],
  ])("%s -> %s", (texto, esperado) => {
    expect(parsearImporte(texto).moneda).toBe(esperado);
  });

  it('"U$S" no se lee como pesos por contener "$"', () => {
    // El "$" pelado se chequea último justo por esto.
    expect(parsearImporte("U$S 120").moneda).toBe("USD");
  });

  it.each(["6500 + iva", "6500 mas iva", "6500 más IVA", "6500 iva aparte"])(
    "detecta 'más IVA' en %s",
    (texto) => {
      expect(parsearImporte(texto).mas_iva).toBe(true);
    },
  );

  it("no inventa 'más IVA' donde no lo hay", () => {
    expect(parsearImporte("6500").mas_iva).toBe(false);
  });
});

describe("lo que no se puede leer devuelve null con motivo", () => {
  it("números en letras: se vuelve a preguntar en vez de adivinar", () => {
    const r = parsearImporte("seis mil quinientos");
    expect(r.valor).toBeNull();
    expect(r.detalle).toContain("números");
  });

  it("dos números sueltos no son un importe", () => {
    const r = parsearImporte("2 x 6500");
    expect(r.valor).toBeNull();
    expect(r.detalle).toContain("no se puede saber cuál");
  });

  it("vacío", () => {
    expect(parsearImporte("").valor).toBeNull();
    expect(parsearImporte("   ").valor).toBeNull();
  });

  it("el motivo NUNCA es una excepción: siempre se puede contestar algo", () => {
    for (const basura of ["???", "$", "abc", "-", ",", "."]) {
      expect(() => parsearImporte(basura)).not.toThrow();
      expect(parsearImporte(basura).detalle).not.toBe("");
    }
  });
});

describe("formatearUy", () => {
  it.each([
    [6500, "6.500"],
    [1234567, "1.234.567"],
    [120.5, "120,50"],
    [6.5, "6,50"],
    [0, "0"],
    [-6500, "-6.500"],
  ])("%d -> %s", (valor, esperado) => {
    expect(formatearUy(valor)).toBe(esperado);
  });

  it("escribe el eco como el usuario escribe los números", () => {
    // Si el eco dijera "6500.00", el usuario no puede verificar lo que le
    // estamos preguntando: no es así como escribe un precio.
    expect(parsearImporte("6.500").detalle).toContain("6.500");
  });
});

describe("cantidades", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["dos", 2],
    ["dos bolsas", 2],
    ["una", 1],
    ["doce", 12],
    ["media", 0.5],
    ["2,5", 2.5],
  ])("%s -> %s", (texto, esperado) => {
    expect(parsearCantidad(texto).valor).toBe(esperado);
  });

  it("cero y negativos no son cantidades", () => {
    expect(parsearCantidad("0").valor).toBeNull();
    expect(parsearCantidad("-3").valor).toBeNull();
  });

  it("las letras se aceptan acá y NO en los importes, a propósito", () => {
    // El rango de "¿cuántos?" es chico y cerrado; el de un precio no lo es, y
    // ahí "dos cincuenta" no tiene una sola lectura.
    expect(parsearCantidad("tres").valor).toBe(3);
    expect(parsearImporte("tres").valor).toBeNull();
  });
});

describe("fracciones con barra: el espacio no decide el precio", () => {
  it.each([
    ["1/2 kg", 0.5],
    ["1/2kg", 0.5],
    ["3/4 de bolsa", 0.75],
    ["2 1/2", 2.5],
  ])("%s -> %s", (texto, esperado) => {
    expect(parsearCantidad(texto).valor).toBe(esperado);
  });

  it("un código con barra no es una fracción: se rechaza, no se adivina", () => {
    // "12/03" tiene num >= den; "3/12" y "art 12/24" tienen un denominador que
    // no es de mostrador. Ninguno de los tres es una cantidad.
    for (const texto of ["12/03", "3/12", "art 12/24"]) {
      const r = parsearCantidad(texto);
      expect(r.valor).toBeNull();
      expect(r.detalle).not.toBe("");
    }
  });

  it("el motivo del rechazo pregunta en vez de adivinar", () => {
    expect(parsearCantidad("3/12").detalle).toContain("código");
  });
});
