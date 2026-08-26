// =============================================================================
// La emisión guiada: que nadie tenga que saber qué es un "111".
//
// Lo que se prueba acá es sobre todo una propiedad negativa: que el flujo NO se
// pueda trancar. Por eso hay un test que recorre el flujo entero paso a paso y
// otro que le tira estados arbitrarios y exige que siempre haya una pregunta o
// un `listo`. Un flujo de emisión que se queda sin próximo paso deja a alguien
// con el cliente en el mostrador y el chat mudo.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  clasificarDocumento,
  construirDesempateReceptor,
  construirListaClientes,
  construirSubmenuFormaPago,
  construirSubmenuIva,
  construirSubmenuMoneda,
  construirSubmenuReceptor,
  interpretarPaso,
  siguientePaso,
  tipoComprobanteSugerido,
  type EstadoEmision,
} from "../src/kapso/emision.js";
import { construirPayloadInteractivo } from "../src/kapso/client.js";
import { handleEmisionGuiada } from "../src/tools/emisionGuiada.js";
import { sanitizeToolResult } from "../src/security/sanitize.js";
import { makeCtx } from "./helpers.js";

/** Fecha cualquiera en el formato de Biller. El flujo no la interpreta, la pasa. */
const HOY = "28/07/2026";

describe("clasificar el documento del receptor", () => {
  it("12 dígitos es un RUT y eso significa empresa", () => {
    const r = clasificarDocumento("219999830019");
    expect(r.tipo).toBe("rut");
    expect(r.clase).toBe("empresa");
    expect(r.normalizado).toBe("219999830019");
  });

  it("7 u 8 dígitos es una cédula y eso significa consumidor final", () => {
    for (const ci of ["1234567", "12345678"]) {
      const r = clasificarDocumento(ci);
      expect(r.tipo, ci).toBe("ci");
      expect(r.clase, ci).toBe("consumidor_final");
    }
  });

  it("limpia puntos y guiones antes de contar", () => {
    expect(clasificarDocumento("21.999.983.0019").normalizado).toBe("219999830019");
    expect(clasificarDocumento("1.234.567-8").tipo).toBe("ci");
  });

  it("un largo raro NO se redondea al tipo más parecido", () => {
    // Un número de 9 dígitos no es "un RUT al que le faltan tres": es un dato
    // que hay que volver a pedir. Deducir el tipo de CFE de acá emitiría mal.
    const r = clasificarDocumento("123456789");
    expect(r.tipo).toBe("desconocido");
    expect(r.clase).toBeNull();
    expect(r.detalle).toContain("9");
  });
});

describe("derivar el tipo de comprobante", () => {
  it("empresa → e-Factura 111, con receptor obligatorio", () => {
    const t = tipoComprobanteSugerido("empresa");
    expect(t.tipo_comprobante).toBe(111);
    expect(t.etiqueta).toBe("e-Factura");
    expect(t.exige_receptor).toBe(true);
  });

  it("consumidor final → e-Ticket 101, receptor según el umbral", () => {
    const t = tipoComprobanteSugerido("consumidor_final");
    expect(t.tipo_comprobante).toBe(101);
    expect(t.etiqueta).toBe("e-Ticket");
    expect(t.exige_receptor).toBe(false);
    expect(t.motivo).toContain("5.000 UI");
  });
});

describe("los mensajes tocables de cada paso", () => {
  it("todos entran en los límites de WhatsApp", () => {
    const mensajes = [
      construirSubmenuReceptor(),
      construirDesempateReceptor(),
      construirSubmenuIva(),
      construirSubmenuFormaPago(),
      construirSubmenuMoneda(),
      construirListaClientes([
        { nombre: "PANADERÍA LA ESPIGA SRL", documento: "219999830019" },
        { nombre: "Pérez", documento: "12345678" },
      ]),
    ];
    for (const m of mensajes) {
      expect(() => construirPayloadInteractivo(m)).not.toThrow();
    }
  });

  it("el submenú de receptor ofrece un 'no sé': dudar es una respuesta válida", () => {
    const ids = construirSubmenuReceptor().botones.map((b) => b.id);
    expect(ids).toContain("emision:receptor:no_se");
  });

  it("la lista de clientes siempre deja salir a uno nuevo", () => {
    const lista = construirListaClientes([{ nombre: "Cliente A" }]);
    const ids = lista.secciones.flatMap((s) => s.filas).map((f) => f.id);
    expect(ids).toContain("emision:cliente:otro");
  });

  it("una lista de clientes larga se recorta para no romper el límite de 10 filas", () => {
    const muchos = Array.from({ length: 40 }, (_, i) => ({ nombre: `Cliente ${i}` }));
    const lista = construirListaClientes(muchos);
    expect(lista.secciones.flatMap((s) => s.filas)).toHaveLength(10);
    expect(() => construirPayloadInteractivo(lista)).not.toThrow();
  });
});

describe("leer lo que tocó el usuario", () => {
  it("los ids de los botones vuelven interpretables", () => {
    expect(interpretarPaso("emision:receptor:empresa")).toEqual({ paso: "receptor", clase: "empresa" });
    expect(interpretarPaso("emision:receptor:final")).toEqual({
      paso: "receptor",
      clase: "consumidor_final",
    });
    expect(interpretarPaso("emision:receptor:no_se")).toEqual({ paso: "receptor_no_se" });
    expect(interpretarPaso("emision:iva:3")).toEqual({ paso: "iva", indicador_facturacion: 3 });
    expect(interpretarPaso("emision:pago:2")).toEqual({ paso: "forma_pago", forma_pago: 2 });
    expect(interpretarPaso("emision:moneda:USD")).toEqual({ paso: "moneda", moneda: "USD" });
    expect(interpretarPaso("emision:cliente:219999830019")).toEqual({
      paso: "cliente",
      documento: "219999830019",
    });
    expect(interpretarPaso("emision:cliente:otro")).toEqual({ paso: "cliente_otro" });
  });

  it("un id que no se entiende devuelve 'ninguna' en vez de tirar", () => {
    // Tiene que poder caer al enrutador general y terminar en una respuesta.
    for (const raw of ["", "hola", "emision:", "emision:iva", "emision:iva:99", "emision:pago:7", "menu:emitir"]) {
      expect(() => interpretarPaso(raw), raw).not.toThrow();
      expect(interpretarPaso(raw).paso, raw).toBe("ninguna");
    }
  });
});

describe("qué preguntar ahora", () => {
  it("sin saber nada, la primera pregunta es a quién se le factura", () => {
    const s = siguientePaso({});
    expect(s.paso).toBe("receptor");
    expect(s.tipo).toBeNull();
    expect(s.listo).toBe(false);
    expect(s.interactivo).not.toBeNull();
  });

  it("apenas se sabe la clase de receptor, el tipo de CFE ya está decidido", () => {
    expect(siguientePaso({ clase_receptor: "empresa" }).tipo?.tipo_comprobante).toBe(111);
    expect(siguientePaso({ clase_receptor: "consumidor_final" }).tipo?.tipo_comprobante).toBe(101);
  });

  it("a una empresa se le pide el RUT; al consumidor final se le ofrece no identificarlo", () => {
    expect(siguientePaso({ clase_receptor: "empresa", fecha_emision: HOY }).paso).toBe("cliente");

    // Al consumidor final también se le pregunta, pero con salida de un toque:
    // el e-Ticket no exige receptor por debajo del umbral de UI.
    const finalSinDatos = siguientePaso({ clase_receptor: "consumidor_final", fecha_emision: HOY });
    expect(finalSinDatos.paso).toBe("cliente");
    expect(finalSinDatos.interactivo).not.toBeNull();

    // Y una vez que dijo "sin identificar", no se le vuelve a preguntar.
    const dijoQueNo = siguientePaso({
      clase_receptor: "consumidor_final",
      fecha_emision: HOY,
      sin_receptor: true,
    });
    expect(dijoQueNo.paso).not.toBe("cliente");
  });

  it("el flujo completo llega a 'listo' preguntando UNA cosa por mensaje", () => {
    const estado: EstadoEmision = {};
    const vistos: string[] = [];

    // Se simula al usuario contestando una pregunta por vez. Cada línea es un
    // mensaje suyo: ninguna carga dos datos juntos.
    const respuestas: Array<(e: EstadoEmision) => void> = [
      (e) => (e.clase_receptor = "empresa"),
      (e) => (e.fecha_emision = HOY),
      (e) => (e.documento = "219999830019"),
      (e) => (e.moneda = "UYU"),
      (e) => (e.forma_pago = 1),
      (e) => (e.items = [{ concepto: "Bolsa de harina" }]),
      (e) => (e.items = [{ ...e.items![0]!, precio: 6000 }]),
      // El IVA incluido se pregunta apenas hay un precio sobre la mesa: es el
      // paso que evita facturar 22% de más sobre un precio de mostrador.
      (e) => (e.montos_brutos = true),
      (e) => (e.items = [{ ...e.items![0]!, cantidad: 2 }]),
      (e) => (e.indicador_facturacion = 3),
      (e) => (e.items_cerrados = true),
      (e) => (e.sin_adenda = true),
    ];

    for (const responder of respuestas) {
      const s = siguientePaso(estado);
      expect(s.listo, `todavía no debería estar listo en ${s.paso}`).toBe(false);
      expect(s.pregunta.length, s.paso).toBeGreaterThan(0);
      vistos.push(s.paso);
      responder(estado);
    }

    const final = siguientePaso(estado);
    expect(final.paso).toBe("confirmar");
    expect(final.listo).toBe(true);
    expect(final.tipo?.tipo_comprobante).toBe(111);

    // El orden es el que pidió el usuario: primero a quién y cuándo, después lo
    // administrativo, y al final el detalle de lo que vendió, campo por campo.
    expect(vistos).toEqual([
      "receptor",
      "fecha",
      "cliente",
      "moneda",
      "forma_pago",
      "concepto",
      "precio",
      "precio_incluye_iva",
      "cantidad",
      "iva",
      "otro_item",
      "adenda",
    ]);
  });

  it("el que llega con todo dicho de una no pasa por once preguntas", () => {
    // "hacele una e-Factura a la panadería, 2 bolsas a 6000, contado, en pesos"
    // El orden largo es la ruta máxima, no la obligatoria.
    const s = siguientePaso({
      clase_receptor: "empresa",
      fecha_emision: HOY,
      documento: "219999830019",
      items: [{ concepto: "Bolsa de harina", cantidad: 2, precio: 6000, indicador_facturacion: 3 }],
      items_cerrados: true,
      sin_adenda: true,
      moneda: "UYU",
      forma_pago: 1,
      montos_brutos: true,
    });
    expect(s.listo).toBe(true);
  });

  it("un cliente nuevo pide dirección y ciudad ANTES de emitir, no en el 422", () => {
    // Verificado contra la API real: dar de alta un cliente en la misma llamada
    // de emisión sin estos dos campos devuelve 422. Descubrirlo al final es
    // perder la conversación entera.
    const base: EstadoEmision = {
      clase_receptor: "empresa",
      fecha_emision: HOY,
      documento: "219999830019",
      cliente_ya_facturado: false,
    };
    expect(siguientePaso(base).paso).toBe("datos_cliente_nuevo");
    expect(siguientePaso({ ...base, direccion_cliente: "Av. Italia 1234" }).paso).toBe(
      "datos_cliente_nuevo",
    );
    expect(
      siguientePaso({ ...base, direccion_cliente: "Av. Italia 1234", ciudad_cliente: "Montevideo" })
        .paso,
    ).not.toBe("datos_cliente_nuevo");

    // Si ya se le facturó antes, existe en Biller: no se le pide nada.
    expect(siguientePaso({ ...base, cliente_ya_facturado: true }).paso).not.toBe(
      "datos_cliente_nuevo",
    );
  });

  it("se pueden cargar varios ítems, y el segundo hereda el IVA del primero", () => {
    const conDosItems: EstadoEmision = {
      clase_receptor: "consumidor_final",
      fecha_emision: HOY,
      sin_receptor: true,
      moneda: "UYU",
      forma_pago: 1,
      montos_brutos: true,
      indicador_facturacion: 3,
      items: [{ concepto: "Café", cantidad: 1, precio: 100 }, {}],
    };
    // El ítem vacío del final es "agregá otro": se pregunta su concepto.
    expect(siguientePaso(conDosItems).paso).toBe("concepto");

    const segundoCompleto = siguientePaso({
      ...conDosItems,
      items: [
        { concepto: "Café", cantidad: 1, precio: 100 },
        { concepto: "Medialuna", cantidad: 3, precio: 50 },
      ],
    });
    // No vuelve a preguntar el IVA: ya hay un default para el comprobante.
    expect(segundoCompleto.paso).toBe("otro_item");
  });

  it("NUNCA se queda sin próximo paso, para cualquier estado parcial", () => {
    // Se recorren todas las combinaciones de campos presentes/ausentes. La
    // propiedad que importa no es cuál paso devuelve, sino que siempre devuelva
    // uno con una pregunta escrita o `listo: true`.
    const campos: Array<[keyof EstadoEmision, unknown]> = [
      ["clase_receptor", "empresa"],
      ["fecha_emision", HOY],
      ["documento", "219999830019"],
      ["items", [{ concepto: "x", precio: 1, cantidad: 1 }]],
      ["items_cerrados", true],
      ["indicador_facturacion", 3],
      ["moneda", "UYU"],
      ["forma_pago", 1],
      ["sin_adenda", true],
    ];

    const PASOS_VALIDOS = [
      "receptor", "fecha", "cliente", "datos_cliente_nuevo", "moneda", "forma_pago",
      "concepto", "precio", "precio_incluye_iva", "cantidad", "iva", "otro_item", "adenda",
      "tasa_cambio", "fecha_vencimiento", "confirmar",
    ];

    for (let mascara = 0; mascara < 2 ** campos.length; mascara++) {
      const estado: Record<string, unknown> = {};
      campos.forEach(([clave, valor], i) => {
        if ((mascara & (1 << i)) !== 0) estado[clave] = valor;
      });

      const s = siguientePaso(estado as EstadoEmision);
      const etiqueta = JSON.stringify(estado);
      expect(s.pregunta.trim(), etiqueta).not.toBe("");
      expect(PASOS_VALIDOS, etiqueta).toContain(s.paso);
      // Si dice que está listo, el tipo de comprobante tiene que estar resuelto:
      // "listo" sin tipo mandaría a emitir sin saber qué se emite.
      if (s.listo) expect(s.tipo, etiqueta).not.toBeNull();
    }
  });

  it("el borrador NO vuelve envuelto por la barrera de salida", async () => {
    // Regresión de un bug real: `concepto` y `razon_social` están en
    // CAMPOS_NO_CONFIABLES, así que la barrera los envolvía en
    // ⟦dato-no-confiable⟧ camino a la salida. Un borrador envuelto que el
    // agente pasa tal cual a la emisión imprime esas marcas en el CFE.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });

    const bruto = await handleEmisionGuiada(
      {
        clase_receptor: "empresa",
        documento: "219999830019",
        nombre_cliente: "PANADERÍA LA ESPIGA SRL",
        items: [{ concepto: "Bolsa de harina 25kg", cantidad: 2, precio: 6000 }],
        indicador_facturacion: 3,
        moneda: "UYU",
        forma_pago: 1,
      },
      ctx,
    );

    // Se pasa por la MISMA barrera que aplica hardenServer en producción.
    const saneado = sanitizeToolResult(bruto, ctx);
    const salida = JSON.stringify(saneado.structuredContent);

    expect(salida).not.toContain("dato-no-confiable");

    const borrador = (saneado.structuredContent as { comprobante_borrador: Record<string, unknown> })
      .comprobante_borrador;
    // Lo que el borrador SÍ tiene que traer: lo que la tool dedujo.
    expect(borrador["tipo_comprobante"]).toBe(111);
    expect(borrador["forma_pago"]).toBe(1);
    expect(borrador["moneda"]).toBe("UYU");
    expect((borrador["items"] as Array<Record<string, unknown>>)[0]!["indicador_facturacion"]).toBe(3);

    // Y lo que a propósito NO trae, con la instrucción de cómo completarlo.
    const completar = (saneado.structuredContent as { completar: string[] }).completar;
    expect(completar.join(" ")).toContain("concepto");
    expect(completar.join(" ")).toContain("razon_social");

    // El espejo del estado dice SI hay concepto, no cuál: devolver el texto lo
    // haría envolver, y un estado reinyectado sin conceptos daría un lazo.
    const eco = (saneado.structuredContent as { estado_entendido: Record<string, unknown> })
      .estado_entendido;
    const items = eco["items"] as Array<Record<string, unknown>>;
    expect(items[0]!["concepto_cargado"]).toBe(true);
    expect(items[0]!["concepto"]).toBeUndefined();
  });

  it("el nombre del cliente va al campo que corresponde al tipo de documento", async () => {
    // La doc es explícita: con tipo_documento 2 (RUT) o 7 el nombre principal
    // es `razon_social`; con 3 (CI), 5 o 6 es `nombre_fantasia`. No son
    // intercambiables, y el borrador antes decía "razon_social" siempre — así
    // que a un consumidor final con cédula se le mandaba el nombre al campo
    // equivocado.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });

    const conRut = await handleEmisionGuiada(
      { documento: "219999830019", nombre_cliente: "PANADERÍA LA ESPIGA SRL" },
      ctx,
    );
    const rut = conRut.structuredContent as {
      comprobante_borrador: { cliente?: Record<string, unknown> };
      completar: string[];
    };
    expect(rut.comprobante_borrador.cliente?.["tipo_documento"]).toBe(2);
    expect(rut.completar.join(" ")).toContain("razon_social");
    expect(rut.completar.join(" ")).not.toContain("nombre_fantasia");

    const conCi = await handleEmisionGuiada(
      { documento: "12345678", nombre_cliente: "Juan Pérez" },
      ctx,
    );
    const ci = conCi.structuredContent as {
      comprobante_borrador: { cliente?: Record<string, unknown> };
      completar: string[];
    };
    expect(ci.comprobante_borrador.cliente?.["tipo_documento"]).toBe(3);
    expect(ci.completar.join(" ")).toContain("nombre_fantasia");

    // `cliente.sucursal.pais` es obligatorio para clientes que no son empresas,
    // así que va siempre y no solo cuando hay que dar de alta al cliente.
    for (const b of [rut, ci]) {
      const suc = b.comprobante_borrador.cliente?.["sucursal"] as Record<string, unknown>;
      expect(suc?.["pais"]).toBe("UY");
    }
  });

  it("un ítem a medio cargar pide EXACTAMENTE el campo que falta", () => {
    // Antes esto devolvía el paso genérico "items" y volvía a pedir las tres
    // cosas. Ahora la pregunta nombra el único dato pendiente.
    const base: EstadoEmision = {
      clase_receptor: "consumidor_final",
      fecha_emision: HOY,
      sin_receptor: true,
      moneda: "UYU",
      forma_pago: 1,
      montos_brutos: true,
    };
    expect(siguientePaso({ ...base, items: [{ concepto: "Bolsa de harina" }] }).paso).toBe("precio");
    expect(
      siguientePaso({ ...base, items: [{ concepto: "Bolsa de harina", precio: 6000 }] }).paso,
    ).toBe("cantidad");
    expect(siguientePaso({ ...base, items: [{ precio: 6000 }] }).paso).toBe("concepto");

    // Y con un precio sobre la mesa pero sin saber si incluye IVA, el paso es
    // ese y no la cantidad: es la diferencia entre facturar $6.000 y $7.320.
    expect(
      siguientePaso({
        ...base,
        montos_brutos: undefined,
        items: [{ concepto: "Bolsa de harina", precio: 6000 }],
      }).paso,
    ).toBe("precio_incluye_iva");
  });
});

// =============================================================================
// Los números del ítem los lee TypeScript, no el modelo.
//
// El caso que motiva todo esto: `Number("6.500")` es 6.5. Si la conversión la
// hace el modelo, la bolsa de harina sale facturada a seis pesos con cincuenta
// y el CFE queda perfectamente bien formado — el error solo se ve leyendo la
// factura.
// =============================================================================

describe("precios escritos como los escribe la gente", () => {
  const BASE = {
    clase_receptor: "consumidor_final" as const,
    sin_receptor: true,
    fecha_emision: "28/07/2026",
    moneda: "UYU",
    forma_pago: 1,
  };

  async function conPrecio(precio: number | string, cantidad?: number | string) {
    const { ctx } = makeCtx();
    const res = await handleEmisionGuiada(
      {
        ...BASE,
        items: [
          {
            concepto: "Bolsa de harina",
            precio,
            ...(cantidad === undefined ? {} : { cantidad }),
            indicador_facturacion: 3,
          },
        ],
      },
      ctx,
    );
    return res.structuredContent as {
      estado_entendido: { items?: Array<{ precio?: number; cantidad?: number }> };
      warnings: string[];
    };
  }

  it('"6.500" son seis mil quinientos, no 6.5', async () => {
    const sc = await conPrecio("6.500");
    expect(sc.estado_entendido.items?.[0]?.precio).toBe(6500);
  });

  it("un número sigue funcionando igual que antes", async () => {
    const sc = await conPrecio(6500);
    expect(sc.estado_entendido.items?.[0]?.precio).toBe(6500);
  });

  it("lo ambiguo se emite como warning con el eco listo para preguntar", async () => {
    const sc = await conPrecio("6.50");
    expect(sc.estado_entendido.items?.[0]?.precio).toBe(6.5);
    const aviso = sc.warnings.find((w) => w.includes("dos formas"));
    expect(aviso).toBeDefined();
    expect(aviso).toContain("ANTES de emitir");
  });

  it("un precio ilegible deja el ítem SIN precio: el flujo lo vuelve a preguntar", async () => {
    // Lo importante es que no invente un número. Sin precio, `siguientePaso`
    // devuelve el paso "precio" y se pregunta de nuevo — que es lo correcto.
    const sc = await conPrecio("seis mil quinientos");
    expect(sc.estado_entendido.items?.[0]?.precio).toBeUndefined();
    expect(sc.warnings.some((w) => w.includes("No se pudo leer el precio"))).toBe(true);
  });

  it('la cantidad acepta "dos"', async () => {
    const sc = await conPrecio(6500, "dos");
    expect(sc.estado_entendido.items?.[0]?.cantidad).toBe(2);
  });
});
