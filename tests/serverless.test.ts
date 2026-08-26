// =============================================================================
// Modo serverless (Vercel).
//
// El riesgo específico de serverless no es que falle: es que funcione a medias.
// La idempotencia vive en memoria y en Vercel no sobrevive entre invocaciones,
// así que un reintento —que en serverless es rutina, no excepción— podría
// emitir dos veces la misma factura ante DGI. Estos tests fijan la degradación
// automática a read_only.
// =============================================================================

import { describe, expect, it } from "vitest";
import { resolverCapabilityModeServerless } from "../src/transport/serverless.js";

describe("degradación de capacidades en serverless", () => {
  it("read_only se mantiene read_only", () => {
    expect(resolverCapabilityModeServerless("read_only", {})).toEqual({
      modo: "read_only",
      degradado: false,
    });
  });

  it("write_enabled se DEGRADA a read_only por defecto", () => {
    // Es lo importante: desplegar en Vercel una config que localmente escribía
    // NO debe habilitar escritura sin que alguien lo decida explícitamente.
    expect(resolverCapabilityModeServerless("write_enabled", {})).toEqual({
      modo: "read_only",
      degradado: true,
    });
  });

  it("solo la variable explícita habilita escritura en serverless", () => {
    expect(
      resolverCapabilityModeServerless("write_enabled", {
        BILLER_SERVERLESS_ALLOW_WRITES: "true",
      }),
    ).toEqual({ modo: "write_enabled", degradado: false });
  });

  it("valores ambiguos NO habilitan escritura", () => {
    // "1", "yes", "TRUE " con espacios, etc. Solo el literal "true" cuenta,
    // igual que el resto de los flags booleanos del proyecto.
    for (const valor of ["1", "yes", "sí", "on", "", "false", undefined]) {
      const r = resolverCapabilityModeServerless("write_enabled", {
        BILLER_SERVERLESS_ALLOW_WRITES: valor,
      });
      expect(r.modo).toBe("read_only");
    }
  });

  it("tolera mayúsculas y espacios en el flag", () => {
    expect(
      resolverCapabilityModeServerless("write_enabled", {
        BILLER_SERVERLESS_ALLOW_WRITES: "  TRUE  ",
      }).modo,
    ).toBe("write_enabled");
  });

  it("el flag no puede ELEVAR un read_only a escritura", () => {
    // El flag levanta la degradación de serverless; no reemplaza a
    // BILLER_CAPABILITY_MODE. Si la config dice read_only, es read_only.
    expect(
      resolverCapabilityModeServerless("read_only", { BILLER_SERVERLESS_ALLOW_WRITES: "true" }),
    ).toEqual({ modo: "read_only", degradado: false });
  });
});
