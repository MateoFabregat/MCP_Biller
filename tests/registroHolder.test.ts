import { describe, expect, it } from "vitest";
import { HolderRegistroTenants } from "../src/tenants/holder.js";
import { construirRegistro } from "../src/tenants/registry.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function registro(id: string, token: string) {
  return construirRegistro([
    { id, auth_token: token, env: { BILLER_API_TOKEN: `api-${id}` } },
  ]);
}

describe("holder del registro de tenants", () => {
  it("publica el registro nuevo de una sola vez sin mutar el snapshot anterior", () => {
    const anterior = registro("panaderia", TOKEN_A);
    const siguiente = registro("ferreteria", TOKEN_B);
    const holder = new HolderRegistroTenants(anterior);

    const snapshotRetenido = holder.actual();
    expect(snapshotRetenido).toBe(anterior);
    expect(snapshotRetenido.tenants.map((tenant) => tenant.id)).toEqual(["panaderia"]);

    holder.reemplazar(siguiente);

    expect(holder.actual()).toBe(siguiente);
    expect(holder.actual().tenants.map((tenant) => tenant.id)).toEqual(["ferreteria"]);
    expect(snapshotRetenido).toBe(anterior);
    expect(snapshotRetenido.tenants.map((tenant) => tenant.id)).toEqual(["panaderia"]);
  });
});
