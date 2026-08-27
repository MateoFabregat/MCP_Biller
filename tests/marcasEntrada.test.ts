// =============================================================================
// La barrera de datos tiene DOS mitades, y esta es la de entrada.
//
// `envolverNoConfiable` marca lo que sale. Estos tests cubren lo que vuelve: el
// modelo lee un preview —o el `ejemplo` de `biller_requisitos_comprobante`, que
// también sale envuelto por tener una clave `concepto`— y copia el string con
// las marcas adentro al comprobante que manda a emitir.
//
// Sin la limpieza, ese CFE sale ante DGI con "⟦dato-no-confiable⟧ Bolsa de
// portland ⟦/dato-no-confiable⟧" impreso en la línea. Y un documento fiscal no
// se edita: se anula con una nota de crédito y se emite de nuevo.
// =============================================================================

import { describe, expect, it } from "vitest";
import { envolverNoConfiable, limpiarMarcas, limpiarMarcasProfundo } from "../src/security/untrusted.js";
import { computeConfirmationToken } from "../src/write/confirm.js";
import { sanitizeToolResult } from "../src/security/sanitize.js";
import { makeCtx } from "./helpers.js";

describe("limpiarMarcas", () => {
  it("deshace exactamente lo que hizo envolverNoConfiable", () => {
    const original = "Bolsa de portland";
    expect(limpiarMarcas(envolverNoConfiable(original))).toBe(original);
  });

  it("no toca un texto que nunca pasó por la barrera", () => {
    const limpio = "Arena fina (m3) — 50% descuento";
    expect(limpiarMarcas(limpio)).toBe(limpio);
  });

  it("también limpia los delimitadores neutralizados", () => {
    // `neutralizarDelimitadores` convierte un intento de cierre en ⟦…⟧ / ⟦/…⟧.
    // Si el modelo copia ESO, tampoco puede terminar en el documento.
    expect(limpiarMarcas("Cemento ⟦…⟧ gris ⟦/…⟧")).toBe("Cemento  gris");
  });

  it("sobrevive a la doble envoltura", () => {
    expect(limpiarMarcas(envolverNoConfiable(envolverNoConfiable("Cal")))).toBe("Cal");
  });
});

describe("limpiarMarcasProfundo", () => {
  it("limpia a cualquier profundidad y dice qué ruta tocó", () => {
    const sucio = {
      tipo_comprobante: 101,
      items: [
        { concepto: envolverNoConfiable("Bolsa de portland"), precio: 480 },
        { concepto: "Arena fina", precio: 1250 },
      ],
      cliente: { razon_social: envolverNoConfiable("Carbonell SA") },
    };
    const { valor, limpiados } = limpiarMarcasProfundo(sucio);

    expect(limpiados).toEqual(["items[0].concepto", "cliente.razon_social"]);
    const v = valor as typeof sucio;
    expect(v.items[0]!.concepto).toBe("Bolsa de portland");
    expect(v.cliente.razon_social).toBe("Carbonell SA");
    // Los números y lo que ya venía limpio pasan intactos.
    expect(v.items[1]!.concepto).toBe("Arena fina");
    expect(v.tipo_comprobante).toBe(101);
  });

  it("no muta el objeto que recibe", () => {
    // Mutarlo le cambiaría el payload bajo los pies a quien después lo hashea.
    const sucio = { adenda: envolverNoConfiable("Gracias por su compra") };
    const copia = JSON.parse(JSON.stringify(sucio));
    limpiarMarcasProfundo(sucio);
    expect(sucio).toEqual(copia);
  });

  it("no reporta nada cuando no había marcas", () => {
    expect(limpiarMarcasProfundo({ concepto: "Cemento", precio: 100 }).limpiados).toEqual([]);
  });
});

describe("el payload sucio y el limpio emiten LO MISMO", () => {
  it("dan el mismo confirmation_token a igual instante", () => {
    // Es la invariante que hace que la limpieza pueda vivir antes del hash: si
    // se limpiara después, el dry-run hashearía el sucio y el confirm el
    // limpio, y el usuario recibiría "el payload cambió" —el aviso que existe
    // para detectar manipulación— por un cambio que hicimos nosotros.
    const ahora = 1_787_800_000_000;
    const sucio = { items: [{ concepto: envolverNoConfiable("Bolsa de portland"), precio: 480 }] };
    const limpio = { items: [{ concepto: "Bolsa de portland", precio: 480 }] };

    const tSucio = computeConfirmationToken(
      "/v3/comprobantes/emitir", "test", limpiarMarcasProfundo(sucio).valor, ahora,
    );
    const tLimpio = computeConfirmationToken(
      "/v3/comprobantes/emitir", "test", limpiarMarcasProfundo(limpio).valor, ahora,
    );
    expect(tSucio).toBe(tLimpio);
  });
});

describe("los ejemplos propios NO se envuelven", () => {
  it("un `ejemplo` con clave `concepto` adentro sale limpio", () => {
    // Es el origen del bug de arriba: el modelo copiaba el ejemplo CON las
    // marcas al comprobante que mandaba a emitir.
    const bruto = {
      content: [{ type: "text", text: "" }],
      structuredContent: {
        faltantes: [
          { campo: "items", ejemplo: [{ concepto: "Servicio de consultoría", cantidad: 1 }] },
        ],
        // Fuera del `ejemplo`, el MISMO nombre de clave sí se envuelve: la
        // excepción es del subárbol, no del nombre.
        items: [{ concepto: "Texto que escribió un proveedor" }],
      },
    };
    const saneado = sanitizeToolResult(bruto as never, makeCtx().ctx);
    const j = saneado.structuredContent as {
      faltantes: Array<{ ejemplo: Array<{ concepto: string }> }>;
      items: Array<{ concepto: string }>;
    };

    expect(j.faltantes[0]!.ejemplo[0]!.concepto).toBe("Servicio de consultoría");
    expect(j.items[0]!.concepto).toContain("dato-no-confiable");
  });
});
