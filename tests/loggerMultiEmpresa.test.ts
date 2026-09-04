// =============================================================================
// El logger en multi-empresa: los secretos se ACUMULAN, no se reemplazan.
//
// `loadConfig` corre una vez por tenant (al abrir sesión, al armar el contexto
// de una tool, y en CADA request de serverless). Si `registrarSecretosParaLogs`
// reemplazara la lista en vez de sumarle, el token de la primera empresa en
// cargar config dejaría de estar protegido en cuanto cargara la segunda —con
// veinte empresas, solo la última queda redactada. Estos tests fijan que eso
// no pase, tanto para el `BILLER_API_TOKEN` (vía `loadConfig`) como para el
// `auth_token` de entrada de cada tenant (vía `construirRegistro`, que no
// necesita que nadie haya abierto sesión todavía).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { logger, olvidarSecretosParaLogs } from "../src/logger.js";
import { construirRegistro } from "../src/tenants/registry.js";

const TOKEN_A = "token-biller-secreto-de-la-empresa-A-123456";
const TOKEN_B = "token-biller-secreto-de-la-empresa-B-789012";
const AUTH_A = "a".repeat(32);

beforeEach(() => {
  olvidarSecretosParaLogs();
});
afterEach(() => {
  olvidarSecretosParaLogs();
});

describe("los secretos de varias empresas conviven en el mismo proceso", () => {
  it("cargar la config de B no destapa el token de A ya cargado, y el auth_token de A también queda cubierto", () => {
    // Dos configuraciones, una por empresa — el flujo real de abrir sesión.
    loadConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: TOKEN_A });
    loadConfig({ BILLER_API_BASE_URL: "https://test.biller.uy", BILLER_API_TOKEN: TOKEN_B });
    // El auth_token de A: la credencial de ENTRADA de la empresa, distinta del
    // BILLER_API_TOKEN de arriba, registrada por `construirRegistro`.
    construirRegistro([{ id: "empresa-a", auth_token: AUTH_A, env: { BILLER_API_TOKEN: TOKEN_A } }]);

    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.error("http.request.error", { message: `falló con ${TOKEN_A}, con ${TOKEN_B} y con ${AUTH_A}` });
    // Capturar la línea ANTES de restaurar: `mockRestore()` también limpia
    // `mock.calls`, igual que `mockReset()`.
    const linea = write.mock.calls[0]?.[0] as string;
    write.mockRestore();

    expect(linea).not.toContain(TOKEN_A);
    expect(linea).not.toContain(TOKEN_B);
    expect(linea).not.toContain(AUTH_A);
    expect(linea.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("construirRegistro con dos tenants redacta sus auth_token sin haber llamado a loadConfig", () => {
    const authDeUnTercero = "c".repeat(32);
    const authDeOtro = "d".repeat(32);

    construirRegistro([
      { id: "panaderia", auth_token: authDeUnTercero, env: { BILLER_API_TOKEN: "token-biller-panaderia-1234567890" } },
      { id: "ferreteria", auth_token: authDeOtro, env: { BILLER_API_TOKEN: "token-biller-ferreteria-1234567890" } },
    ]);

    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.error("algo", { message: `${authDeUnTercero} y ${authDeOtro}` });
    const linea = write.mock.calls[0]?.[0] as string;
    write.mockRestore();

    expect(linea).not.toContain(authDeUnTercero);
    expect(linea).not.toContain(authDeOtro);
    expect(linea.match(/\[REDACTED\]/g)).toHaveLength(2);
  });
});
