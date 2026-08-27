// =============================================================================
// El borrador de emisión, probado SIN pasar por la tool.
//
// Ese es el punto del archivo, más que las aserciones: estas reglas —cómo se
// leen los importes que escribió una persona, qué gana cuando el texto y el
// agente dicen cosas distintas, y qué campos NO pueden volver por el canal del
// modelo— eran alcanzables solo llamando a `biller_emision_guiada`. Un test que
// las ejercita con un objeto y nada más es la prueba de que dejaron de estarlo.
//
// La conducta a través de la tool sigue cubierta en `emisionGuiada.test.ts`.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  aplicarAlItemEnCurso,
  borradorComprobante,
  normalizarItems,
  rellenarDesdePedido,
} from "../src/kapso/borradorEmision.js";
import { extraerPedidoEmision } from "../src/kapso/extraerPedido.js";
import type { EstadoEmision } from "../src/kapso/emision.js";

describe("normalizarItems: la plata la lee TypeScript", () => {
  it('"6.500" son seis mil quinientos, no seis con cincuenta', () => {
    const r = normalizarItems([{ concepto: "Portland", precio: "6.500" }]);
    expect(r.items?.[0]?.precio).toBe(6500);
    expect(r.items?.[0]?.precio_ambiguo).toBe(false);
  });

  it('"6.50" queda MARCADO, no solo avisado: la confirmación llega tres mensajes después', () => {
    const r = normalizarItems([{ concepto: "Portland", precio: "6.50" }]);
    expect(r.items?.[0]?.precio_ambiguo).toBe(true);
    expect(r.warnings.join(" ")).toContain("ANTES de emitir");
  });

  it("un precio ilegible deja el ítem SIN precio, no con un número inventado", () => {
    const r = normalizarItems([{ concepto: "Portland", precio: "no sé" }]);
    expect(r.items?.[0]?.precio).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
  });

  it("un precio numérico apaga la marca vieja en vez de dejarla viva", () => {
    // `fusionarEstado` no pisa con `undefined`: sin el false explícito, la
    // advertencia del "6.50" anterior sobreviviría a la corrección.
    const r = normalizarItems([{ precio: 6500 }]);
    expect(r.items?.[0]?.precio_ambiguo).toBe(false);
  });

  it("el warning dice de qué ítem habla cuando hay más de uno", () => {
    const r = normalizarItems([
      { concepto: "Café", precio: 100 },
      { concepto: "Té", precio: "qué se yo" },
    ]);
    expect(r.warnings[0]).toContain("ítem 2");
  });
});

describe("aplicarAlItemEnCurso: el botón no dice a qué ítem pertenece", () => {
  it("aplica sobre el ÚLTIMO, que es la convención de siguientePaso", () => {
    const estado: EstadoEmision = { items: [{ concepto: "Café" }, { concepto: "Té" }] };
    aplicarAlItemEnCurso(estado, (i) => (i.cantidad = 3));
    expect(estado.items?.[0]?.cantidad).toBeUndefined();
    expect(estado.items?.[1]?.cantidad).toBe(3);
  });

  it("si no hay ninguno, lo crea", () => {
    const estado: EstadoEmision = {};
    aplicarAlItemEnCurso(estado, (i) => (i.cantidad = 2));
    expect(estado.items).toEqual([{ cantidad: 2 }]);
  });
});

describe("rellenarDesdePedido: la jerarquía no se invierte", () => {
  it("lo explícito del agente NUNCA se pisa con lo leído del texto", () => {
    const estado: EstadoEmision = {
      nombre_cliente: "Panadería La Espiga",
      items: [{ concepto: "Bolsa de portland", cantidad: 3, precio: 7000 }],
    };
    rellenarDesdePedido(estado, extraerPedidoEmision("facturale a perez 2 bolsas de portland a 6.500")!);
    expect(estado.nombre_cliente).toBe("Panadería La Espiga");
    expect(estado.items?.[0]).toMatchObject({ cantidad: 3, precio: 7000 });
  });

  it("llena el hueco que el agente no mandó", () => {
    const estado: EstadoEmision = { items: [{ concepto: "Bolsa de portland", cantidad: 3 }] };
    rellenarDesdePedido(estado, extraerPedidoEmision("facturale a perez 2 bolsas de portland a 6.500")!);
    expect(estado.items?.[0]?.precio).toBe(6500);
    expect(estado.items?.[0]?.cantidad).toBe(3);
  });

  it("los dólares se convierten en PREGUNTA, no en moneda", () => {
    const estado: EstadoEmision = {};
    rellenarDesdePedido(estado, extraerPedidoEmision("facturale el flete, son 200 dolares")!);
    expect(estado.moneda).toBeUndefined();
    expect(estado.moneda_dudosa).toBe(true);
  });

  it("una corrección no es un pedido: no deja un cliente llamado 'eran'", () => {
    const estado: EstadoEmision = {};
    rellenarDesdePedido(estado, extraerPedidoEmision("pará, eran 3 no 2")!);
    expect(estado.nombre_cliente).toBeUndefined();
    expect(estado.items).toBeUndefined();
  });

  it("un precio que no entró en ninguna línea abre un ítem vacío", () => {
    const estado: EstadoEmision = {};
    const puestos = rellenarDesdePedido(
      estado,
      extraerPedidoEmision("facturale a gonzalez 3 cajas de clavos a 1200 y portland a 6500")!,
    );
    expect(estado.items?.[estado.items.length - 1]).toEqual({});
    expect(puestos.join(" ")).toContain("precio sin ubicar");
  });
});

describe("borradorComprobante: qué sale y qué NO puede salir", () => {
  const BASE: EstadoEmision = {
    documento: "219999830019",
    nombre_cliente: "PANADERÍA LA ESPIGA SRL",
    adenda: "orden 4471",
    items: [{ concepto: "Bolsa de harina", cantidad: 2, precio: 6000 }],
    indicador_facturacion: 3,
    montos_brutos: false,
  };

  it("no devuelve concepto, razón social ni adenda: la barrera las envolvería", () => {
    const { borrador, completar } = borradorComprobante(BASE, 111);
    const texto = JSON.stringify(borrador);
    expect(texto).not.toContain("Bolsa de harina");
    expect(texto).not.toContain("ESPIGA");
    expect(texto).not.toContain("4471");
    expect(completar.join(" ")).toContain("razon_social");
    expect(completar.join(" ")).toContain("adenda");
  });

  it("tampoco el numero_interno, que es toda la defensa contra el duplicado", () => {
    const { borrador } = borradorComprobante({ ...BASE, numero_interno: "wa-abc" }, 111);
    expect(JSON.stringify(borrador)).not.toContain("wa-abc");
  });

  it("`montos_brutos: false` VA IGUAL: el silencio ya es una respuesta, y es la otra", () => {
    const { borrador } = borradorComprobante(BASE, 111);
    expect(borrador["montos_brutos"]).toBe(false);
  });

  it("con cédula el nombre va en nombre_fantasia, no en razon_social", () => {
    const { borrador, completar } = borradorComprobante(
      { ...BASE, documento: "12345678" },
      101,
    );
    expect((borrador["cliente"] as Record<string, unknown>)["tipo_documento"]).toBe(3);
    expect(completar.join(" ")).toContain("nombre_fantasia");
  });

  it("un ítem a medio cargar no entra: sería un 422 sobre un campo que nadie vio", () => {
    const { borrador } = borradorComprobante(
      { ...BASE, items: [{ concepto: "Bolsa de harina", precio: 6000 }, { precio: 50 }, {}] },
      111,
    );
    expect(borrador["items"]).toHaveLength(1);
  });

  it("dirección y ciudad solo cuando hay que dar de alta al cliente", () => {
    const nuevo = borradorComprobante(
      { ...BASE, cliente_ya_facturado: false, direccion_cliente: "Rivera 1234", ciudad_cliente: "Melo" },
      111,
    ).borrador["cliente"] as { sucursal: Record<string, unknown> };
    expect(nuevo.sucursal).toMatchObject({ pais: "UY", direccion: "Rivera 1234", ciudad: "Melo" });

    const conocido = borradorComprobante(
      { ...BASE, cliente_ya_facturado: true, direccion_cliente: "Rivera 1234" },
      111,
    ).borrador["cliente"] as { sucursal: Record<string, unknown> };
    expect(conocido.sucursal).toEqual({ pais: "UY" });
  });
});
