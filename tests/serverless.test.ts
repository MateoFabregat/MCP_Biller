// =============================================================================
// Modo serverless (Vercel).
//
// El riesgo específico de serverless no es que falle: es que funcione a medias.
// La idempotencia vive en memoria y en Vercel no sobrevive entre invocaciones,
// así que un reintento —que en serverless es rutina, no excepción— podría
// emitir dos veces la misma factura ante DGI. Estos tests fijan la degradación
// automática a read_only.
// =============================================================================

import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.js";
import { manejarRequestServerless, resolverCapabilityModeServerless } from "../src/transport/serverless.js";

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

// =============================================================================
// Un registro de tenants inválido no le cuenta la topología a un cliente sin
// autenticar: el detalle completo (ids de empresa, phone_number_id, rutas) va
// SOLO al log, y la respuesta a un cliente que ni siquiera mandó Authorization
// tiene que ser genérica.
// =============================================================================

function reqSinAuth(): IncomingMessage {
  return { headers: {} } as IncomingMessage;
}

/** ServerResponse falso: guarda status y cuerpo, no abre ningún socket. */
function resFalso(): { res: ServerResponse; status: () => number | undefined; body: () => string } {
  let status: number | undefined;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    setHeader: () => res,
    end: (chunk?: string) => {
      if (chunk !== undefined) body += chunk;
    },
    on: () => res,
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

describe("un registro de tenants inválido no filtra topología sin autenticar", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.BILLER_TENANTS_JSON = JSON.stringify([
      {
        id: "panaderia-rivera",
        auth_token: "a".repeat(32),
        env: { BILLER_API_TOKEN: "token-biller-panaderia-1234567890", KAPSO_PHONE_NUMBER_ID: "1234567890" },
      },
      {
        id: "ferreteria-centro",
        auth_token: "b".repeat(32),
        env: { BILLER_API_TOKEN: "token-biller-ferreteria-1234567890", KAPSO_PHONE_NUMBER_ID: "1234567890" },
      },
    ]);
    delete process.env.BILLER_TENANTS_PATH;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("responde 500 genérico sin ids de tenant, sin el phone_number_id y sin ninguna barra", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const { res, status, body } = resFalso();
    await manejarRequestServerless(reqSinAuth(), res);

    expect(status()).toBe(500);
    const cuerpo = body();
    expect(cuerpo).not.toContain("KAPSO_PHONE_NUMBER_ID");
    expect(cuerpo).not.toContain("panaderia-rivera");
    expect(cuerpo).not.toContain("ferreteria-centro");
    expect(cuerpo).not.toContain("/");
    expect(cuerpo).toContain("Revisá los logs del server");

    // El detalle completo sí llega al log.
    expect(errorSpy).toHaveBeenCalledWith(
      "serverless.registro.invalido",
      expect.objectContaining({ message: expect.stringContaining("KAPSO_PHONE_NUMBER_ID") }),
    );

    errorSpy.mockRestore();
  });
});
