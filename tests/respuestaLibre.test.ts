// =============================================================================
// Contestar ESCRIBIENDO, no solo tocando.
//
// `interpretarPaso` entiende ids de botón, y eso alcanza mientras el usuario
// toque. No siempre toca: el botón quedó arriba en el chat, contesta desde el
// reloj, o escribe porque está apurado. Cuando eso pasaba, el mensaje no
// matcheaba nada, el estado no cambiaba, y el flujo repetía LA MISMA PREGUNTA
// para siempre.
//
// El caso que más duele es el que la propia pregunta invita: en el paso
// `cliente` el texto dice, textual, 'decime "sin identificar" y sigo'.
// =============================================================================

import { describe, expect, it } from "vitest";
import { interpretarRespuestaLibre } from "../src/kapso/emision.js";

describe("la frase que la pregunta sugiere, funciona", () => {
  it('"sin identificar" cierra el paso del cliente', () => {
    expect(interpretarRespuestaLibre("sin identificar", "cliente")).toEqual({
      paso: "cliente_sin_identificar",
    });
  });

  it('un número pelado contesta la cotización, que es lo que pide "por ejemplo 40"', () => {
    expect(interpretarRespuestaLibre("40", "tasa_cambio")).toEqual({ paso: "tasa_cambio", tasa: 40 });
    // Acá se escribe con coma.
    expect(interpretarRespuestaLibre("40,5", "tasa_cambio")).toEqual({ paso: "tasa_cambio", tasa: 40.5 });
  });
});

describe("se lee CONTRA la pregunta abierta, no en el aire", () => {
  // Es lo que hace que interpretar texto libre sea leer y no adivinar: la misma
  // palabra significa cosas distintas según qué se preguntó.
  it('"no" es "sin identificar" en el paso cliente y "sin IVA" en el de montos', () => {
    expect(interpretarRespuestaLibre("no", "cliente")).toEqual({ paso: "cliente_sin_identificar" });
    expect(interpretarRespuestaLibre("no", "montos_brutos")).toEqual({
      paso: "montos_brutos",
      incluye_iva: false,
    });
  });

  it('"no" no significa nada en un paso que no preguntó por sí o por no', () => {
    expect(interpretarRespuestaLibre("no", "receptor")).toEqual({ paso: "ninguna" });
  });

  it("un paso desconocido nunca mueve el flujo", () => {
    expect(interpretarRespuestaLibre("consumidor final", "confirmar")).toEqual({ paso: "ninguna" });
  });
});

describe("cómo escribe la gente", () => {
  it.each([
    ["consumidor final", "consumidor_final"],
    ["Consumidor Final", "consumidor_final"],
    ["mostrador", "consumidor_final"],
    ["empresa", "empresa"],
    ["con RUT", "empresa"],
  ])('"%s" en el paso receptor', (texto, clase) => {
    expect(interpretarRespuestaLibre(texto, "receptor")).toEqual({ paso: "receptor", clase });
  });

  it("los tildes y los signos no cambian nada", () => {
    expect(interpretarRespuestaLibre("¿no sé?", "receptor")).toEqual({ paso: "receptor_no_se" });
  });

  it('"con iva" es la respuesta del precio de mostrador uruguayo', () => {
    expect(interpretarRespuestaLibre("con iva", "montos_brutos")).toEqual({
      paso: "montos_brutos",
      incluye_iva: true,
    });
  });
});

describe("ante la duda, no mueve nada", () => {
  it.each(["", "   ", "mmm", "dale pero esperá", "capaz"])('"%s" devuelve ninguna', (texto) => {
    // Que el agente repregunte es barato; que un texto ambiguo mueva el flujo
    // solo, no.
    expect(interpretarRespuestaLibre(texto, "cliente").paso).toBe("ninguna");
  });
});

describe('"pesos" cuando ya se está pidiendo la cotización', () => {
  it("corrige la moneda en vez de ignorarse", () => {
    // A ese paso se llega con la moneda en USD, muchas veces heredada del
    // perfil de la casa y no dicha por nadie. Ignorar la corrección y tomar el
    // número siguiente como tasa convierte $960 en $38.400.
    expect(interpretarRespuestaLibre("pesos", "tasa_cambio")).toEqual({
      paso: "moneda",
      moneda: "UYU",
    });
  });
});
