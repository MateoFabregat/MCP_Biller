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
  aplicarDefaults,
  clasificarDocumento,
  construirDesempateReceptor,
  construirListaClientes,
  construirSubmenuConceptoExtra,
  construirSubmenuFormaPago,
  construirSubmenuIva,
  construirSubmenuIvaFusionado,
  construirSubmenuMoneda,
  construirSubmenuReceptor,
  interpretarPaso,
  separarDireccionCiudad,
  siguientePaso,
  sugiereDolares,
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

  it("el flujo completo llega a 'listo' en CUATRO preguntas, no en doce", () => {
    // ESTE TEST ES EL ANTES/DESPUÉS DE LA REFORMA.
    //
    // Antes eran doce pasos: receptor · fecha · cliente · moneda · forma_pago ·
    // concepto · precio · precio_incluye_iva · cantidad · iva · otro_item ·
    // adenda. Ocho de esos doce se contestaban solos o preguntaban dos veces lo
    // mismo. Hoy quedan cuatro, y ninguno se puede deducir:
    //
    //   · a quién (deriva el tipo de CFE),
    //   · su RUT (la e-Factura lo exige siempre),
    //   · qué vendió y a cuánto (el único dato que solo el usuario tiene),
    //   · si el precio lleva el IVA adentro (equivocarse cambia la factura 22%).
    //
    // Lo demás sale por default y aparece en el preview. Ver `aplicarDefaults`.
    const estado: EstadoEmision = {};
    const vistos: string[] = [];

    const respuestas: Array<(e: EstadoEmision) => void> = [
      (e) => (e.clase_receptor = "empresa"),
      (e) => (e.documento = "219999830019"),
      (e) => (e.items = [{ concepto: "Bolsa de harina" }]),
      (e) => (e.items = [{ ...e.items![0]!, precio: 6000 }]),
      // El paso fusionado contesta las DOS cosas de una: criterio de precio y
      // tasa básica. Es exactamente lo que hacen sus dos botones grandes.
      (e) => {
        e.montos_brutos = true;
        e.indicador_facturacion = 3;
      },
    ];

    for (const responder of respuestas) {
      const s = siguientePaso(estado, { hoy: HOY });
      expect(s.listo, `todavía no debería estar listo en ${s.paso}`).toBe(false);
      expect(s.pregunta.length, s.paso).toBeGreaterThan(0);
      vistos.push(s.paso);
      responder(estado);
    }

    const final = siguientePaso(estado, { hoy: HOY });
    expect(final.paso).toBe("confirmar");
    expect(final.listo).toBe(true);
    expect(final.tipo?.tipo_comprobante).toBe(111);

    // Cinco entradas, cuatro preguntas: `concepto` y `precio` son el mismo dato
    // partido en dos mensajes cortos, que es como se contesta desde el mostrador.
    expect(vistos).toEqual(["receptor", "cliente", "concepto", "precio", "iva"]);

    // Ni la fecha ni la forma de pago ni la moneda ni la cantidad se
    // preguntaron — y las cuatro quedaron resueltas igual.
    const resuelto = aplicarDefaults(estado, { hoy: HOY });
    expect(resuelto.estado.fecha_emision).toBe(HOY);
    expect(resuelto.estado.forma_pago).toBe(1);
    expect(resuelto.estado.moneda).toBe("UYU");
    expect(resuelto.estado.items?.[0]?.cantidad).toBe(1);
    expect(resuelto.aplicados).toEqual(["fecha_emision", "moneda", "forma_pago", "cantidad"]);
  });

  it("un cliente conocido con la venta en una línea va DERECHO al preview", () => {
    // "facturale a la panadería 2 bolsas a 6500, con IVA incluido".
    // Cero preguntas: el objetivo de toda la reforma.
    const s = siguientePaso(
      {
        clase_receptor: "empresa",
        documento: "219999830019",
        cliente_ya_facturado: true,
        items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
        montos_brutos: true,
        indicador_facturacion: 3,
      },
      { hoy: HOY },
    );
    expect(s.paso).toBe("confirmar");
    expect(s.listo).toBe(true);
  });

  it("sin el criterio de IVA queda UNA sola pregunta, la que mueve plata", () => {
    // "facturale a Pérez 2 bolsas a 6500", sin decir si el precio lleva IVA.
    // Es el camino real más corto: el flujo pregunta una vez y muestra el
    // preview. Antes desde acá faltaban siete preguntas.
    const estado: EstadoEmision = {
      clase_receptor: "empresa",
      documento: "219999830019",
      cliente_ya_facturado: true,
      items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
    };

    const primera = siguientePaso(estado, { hoy: HOY });
    expect(primera.paso).toBe("iva");
    // Y es UN mensaje con las dos respuestas adentro, no dos mensajes.
    expect(primera.interactivo?.botones).toHaveLength(3);
    expect(primera.interactivo?.botones.map((b) => b.id)).toEqual([
      "emision:iva_incluido:si",
      "emision:iva_incluido:no",
      "emision:iva_incluido:otro",
    ]);
    // El precio va escrito a la uruguaya en la pregunta: es el eco que le
    // permite al usuario detectar que leímos 6,5 en vez de 6.500.
    expect(primera.interactivo?.cuerpo).toContain("$6.500");

    // Tocar "✅ Ya incluye IVA" resuelve las dos mitades (eso lo hace la tool,
    // ver el case "montos_brutos" de emisionGuiada.ts).
    estado.montos_brutos = true;
    estado.indicador_facturacion = 3;
    expect(siguientePaso(estado, { hoy: HOY }).listo).toBe(true);
  });

  it("el que llega con todo dicho de una no pasa por ninguna pregunta", () => {
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
    const abierto = siguientePaso(conDosItems);
    expect(abierto.paso).toBe("concepto");
    // Y la pregunta trae su propia salida. Sin ella, tocar ➕ por error deja al
    // usuario en una pregunta abierta sin ningún botón — el mismo callejón que
    // el paso `otro_item` había venido a tapar, reintroducido por al lado.
    expect(abierto.interactivo?.botones.map((b) => b.id)).toEqual(["emision:item:cancelar"]);

    const segundoCompleto = siguientePaso({
      ...conDosItems,
      items: [
        { concepto: "Café", cantidad: 1, precio: 100 },
        { concepto: "Medialuna", cantidad: 3, precio: 50 },
      ],
    });
    // No vuelve a preguntar el IVA (ya hay un default para el comprobante) ni
    // "¿otro ítem?": eso ahora es un botón del preview, que es donde el usuario
    // tiene el comprobante entero delante.
    expect(segundoCompleto.paso).toBe("confirmar");
    expect(segundoCompleto.listo).toBe(true);
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

    // Los pasos que quedaron. `cantidad`, `otro_item` y `adenda` desaparecieron
    // del tipo; `fecha` y `forma_pago` siguen en el tipo pero ya no se alcanzan
    // (tienen default), y por eso se dejan acá: si alguna vez volvieran a
    // aparecer, esta lista los admite y el test que cuenta pasos los delata.
    const PASOS_VALIDOS = [
      "receptor", "fecha", "cliente", "datos_cliente_nuevo", "moneda", "forma_pago",
      "concepto", "precio", "precio_incluye_iva", "iva",
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
    expect(siguientePaso({ ...base, items: [{ precio: 6000 }] }).paso).toBe("concepto");

    // La cantidad YA NO ES UN PASO: falta y se completa en 1. El que dijo "2
    // bolsas" la trajo; el que no la dijo casi siempre vende una, y en el
    // preview la ve escrita como "1 × Bolsa de harina".
    const sinCantidad = siguientePaso({
      ...base,
      indicador_facturacion: 3,
      items: [{ concepto: "Bolsa de harina", precio: 6000 }],
    });
    expect(sinCantidad.paso).toBe("confirmar");
    expect(sinCantidad.listo).toBe(true);

    // Y con un precio sobre la mesa pero sin saber si incluye IVA, el paso es
    // ese: es la diferencia entre facturar $6.000 y $7.320.
    expect(
      siguientePaso({
        ...base,
        montos_brutos: undefined,
        indicador_facturacion: 3,
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

// =============================================================================
// LA REFORMA: doce preguntas a cuatro.
//
// Lo que se prueba acá es cada una de las preguntas que dejó de hacerse, y —
// más importante— que ninguna se haya ido en silencio: todo default tiene que
// poder revertirse con una frase, y todo default tiene que estar escrito en el
// preview antes de que un CFE exista.
// =============================================================================

describe("los defaults del flujo", () => {
  const HOY_FIJO = "26/08/2026";

  it("la fecha, la moneda y la forma de pago se completan solas", () => {
    const { estado, aplicados } = aplicarDefaults({}, { hoy: HOY_FIJO });
    expect(estado.fecha_emision).toBe(HOY_FIJO);
    expect(estado.moneda).toBe("UYU");
    expect(estado.forma_pago).toBe(1);
    expect(aplicados).toEqual(["fecha_emision", "moneda", "forma_pago"]);
  });

  it("lo que el usuario dijo NUNCA se pisa", () => {
    const dicho: EstadoEmision = {
      fecha_emision: "20/08/2026",
      moneda: "USD",
      forma_pago: 2,
      items: [{ concepto: "Bolsa", precio: 100, cantidad: 7 }],
    };
    const { estado, aplicados } = aplicarDefaults(dicho, { hoy: HOY_FIJO });
    expect(estado.fecha_emision).toBe("20/08/2026");
    expect(estado.moneda).toBe("USD");
    expect(estado.forma_pago).toBe(2);
    expect(estado.items?.[0]?.cantidad).toBe(7);
    expect(aplicados).toEqual([]);
  });

  it("NO escribe en el estado que le pasaron: devuelve una copia", () => {
    // Es la decisión que hace que las correcciones funcionen. Si el default se
    // escribiera en el borrador guardado, "no me dijeron nada" y "el usuario
    // dijo contado" quedarían indistinguibles — y `fusionarEstado` trata lo
    // guardado como base, así que el default competiría de igual a igual con
    // una respuesta real del usuario.
    const original: EstadoEmision = { items: [{ concepto: "Bolsa", precio: 100 }] };
    aplicarDefaults(original, { hoy: HOY_FIJO });
    expect(original.fecha_emision).toBeUndefined();
    expect(original.forma_pago).toBeUndefined();
    expect(original.items?.[0]?.cantidad).toBeUndefined();
  });

  it("la cantidad se completa en 1 solo en los ítems que ya tienen concepto", () => {
    // Un ítem vacío es "estoy por agregar otra cosa", no un ítem a medio
    // cargar: ponerle cantidad 1 lo haría parecer lo segundo.
    const { estado } = aplicarDefaults(
      { items: [{ concepto: "Café", precio: 100 }, {}] },
      { hoy: HOY_FIJO },
    );
    expect(estado.items?.[0]?.cantidad).toBe(1);
    expect(estado.items?.[1]?.cantidad).toBeUndefined();
  });

  it("siguientePaso no lee el reloj: 'hoy' entra por parámetro", () => {
    // La máquina de estados es pura. Sin este seam, el test de la fecha
    // dependería de cuándo se corra — y el módulo empezaría a tocar el reloj
    // justo en el código que decide qué fecha va impresa en un CFE.
    const estado: EstadoEmision = {
      clase_receptor: "consumidor_final",
      sin_receptor: true,
      items: [{ concepto: "Café", precio: 100, cantidad: 1 }],
      montos_brutos: true,
      indicador_facturacion: 3,
    };
    expect(siguientePaso(estado, { hoy: "01/01/2020" }).listo).toBe(true);
    expect(aplicarDefaults(estado, { hoy: "01/01/2020" }).estado.fecha_emision).toBe("01/01/2020");
  });
});

describe("la moneda: default UYU, pero preguntada si el texto habla de dólares", () => {
  it("reconoce las formas en que la gente escribe dólares", () => {
    for (const texto of [
      "son 200 dolares",
      "SON 200 DÓLARES",
      "cobrale 200 dólar",
      "u$s 200",
      "US$ 200",
      "200 usd",
    ]) {
      expect(sugiereDolares(texto), texto).toBe(true);
    }
  });

  it("no confunde una venta en pesos con una en dólares", () => {
    for (const texto of [
      "facturale 2 bolsas a 6500",
      "cobrale 200 pesos",
      "dolarizado no, en pesos",
      "vendile un dolarizador", // no es una palabra suelta
    ]) {
      expect(sugiereDolares(texto), texto).toBe(false);
    }
  });

  it("en el silencio la moneda no se pregunta: es UYU", async () => {
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            mensaje: "facturale a la panadería 2 bolsas a 6500",
            clase_receptor: "empresa",
            documento: "219999830019",
            cliente_ya_facturado: true,
            items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).not.toBe("moneda");
    expect(r.comprobante_borrador.moneda).toBe("UYU");
    expect(r.defaults_aplicados).toContain("moneda");
  });

  it("si el texto dice dólares, ahí SÍ se pregunta", async () => {
    // Un falso positivo cuesta una pregunta. Un falso negativo emite una
    // factura en pesos por un precio cotizado en dólares: un error de 40x que
    // además sale perfectamente bien formado ante DGI.
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            mensaje: "facturale a la panadería el servicio, son 200 dólares",
            clase_receptor: "empresa",
            documento: "219999830019",
            cliente_ya_facturado: true,
            items: [{ concepto: "Servicio", cantidad: 1, precio: 200 }],
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).toBe("moneda");
    expect(r.comprobante_borrador.moneda).toBeUndefined();
  });

  it("elegida la moneda, la duda no vuelve", async () => {
    const { ctx } = makeCtx();
    const SESION = "+59899111222";
    await handleEmisionGuiada(
      {
        sesion: SESION,
        mensaje: "son 200 dólares",
        clase_receptor: "empresa",
        documento: "219999830019",
        cliente_ya_facturado: true,
        items: [{ concepto: "Servicio", cantidad: 1, precio: 200 }],
      },
      ctx,
    );
    const r = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:moneda:UYU" }, ctx)
      ).content[0]!.text,
    );
    expect(r.paso).not.toBe("moneda");
    expect(r.comprobante_borrador.moneda).toBe("UYU");
  });
});

describe("el IVA, en un solo paso", () => {
  const BASE: EstadoEmision = {
    clase_receptor: "consumidor_final",
    sin_receptor: true,
    fecha_emision: "26/08/2026",
    moneda: "UYU",
    forma_pago: 1,
    items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
  };

  it("con las dos mitades sin resolver, es UN mensaje de tres botones", () => {
    const s = siguientePaso(BASE);
    expect(s.paso).toBe("iva");
    expect(s.interactivo?.botones.map((b) => b.titulo)).toEqual([
      "✅ Ya incluye IVA",
      "➕ Se suma aparte",
      "🔢 Otro IVA",
    ]);
    // Y entra en los límites de WhatsApp con los tres botones puestos.
    expect(() => construirPayloadInteractivo(s.interactivo!)).not.toThrow();
  });

  it("tocar un botón grande resuelve montos_brutos Y el indicador", async () => {
    // Si el indicador no se fijara al tocar, la fusión no ahorraría nada: el
    // paso siguiente volvería a ser la tasa.
    const { ctx } = makeCtx();
    const SESION = "+59899333444";
    await handleEmisionGuiada(
      {
        sesion: SESION,
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
      },
      ctx,
    );
    const r = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:iva_incluido:si" }, ctx)
      ).content[0]!.text,
    );
    expect(r.paso).toBe("confirmar");
    expect(r.listo_para_requisitos).toBe(true);
    expect(r.comprobante_borrador.montos_brutos).toBe(true);
    expect(r.comprobante_borrador.items[0].indicador_facturacion).toBe(3);
  });

  it("'🔢 Otro IVA' abre las tasas y después vuelve a preguntar el criterio", async () => {
    const { ctx } = makeCtx();
    const SESION = "+59899555666";
    await handleEmisionGuiada(
      {
        sesion: SESION,
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        items: [{ concepto: "Leche", cantidad: 6, precio: 60 }],
      },
      ctx,
    );

    // Paso 1: el tercer botón no contesta nada, abre la pregunta de la tasa.
    const tasas = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:iva_incluido:otro" }, ctx)
      ).content[0]!.text,
    );
    expect(tasas.paso).toBe("iva");
    expect(tasas.pregunta).toContain("mínima");

    // Paso 2: elegida la tasa mínima, queda el criterio de precio — ahora con
    // DOS botones, porque la tasa ya no está en discusión.
    const criterio = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:iva:2" }, ctx)).content[0]!
        .text,
    );
    expect(criterio.paso).toBe("precio_incluye_iva");

    const listo = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:iva_incluido:no" }, ctx)
      ).content[0]!.text,
    );
    expect(listo.paso).toBe("confirmar");
    // Y el 10% elegido a mano NO se pisa con la tasa básica del botón grande.
    expect(listo.comprobante_borrador.items[0].indicador_facturacion).toBe(2);
    expect(listo.comprobante_borrador.montos_brutos).toBe(false);
  });

  it("el submenú fusionado entra en los límites de WhatsApp", () => {
    expect(() => construirPayloadInteractivo(construirSubmenuIvaFusionado(6500, "UYU"))).not.toThrow();
    expect(() => construirPayloadInteractivo(construirSubmenuConceptoExtra())).not.toThrow();
  });
});

describe("dirección y ciudad en un solo mensaje", () => {
  it('parte "Rivera 1234, Melo" por la coma', () => {
    expect(separarDireccionCiudad("Rivera 1234, Melo")).toEqual({
      direccion: "Rivera 1234",
      ciudad: "Melo",
    });
  });

  it("parte por la ÚLTIMA coma: las direcciones llevan comas adentro", () => {
    // Con la primera, "apto 302" se convertía en la ciudad de un cliente que
    // queda dado de alta así para siempre.
    expect(separarDireccionCiudad("Av. Italia 1234, apto 302, Montevideo")).toEqual({
      direccion: "Av. Italia 1234, apto 302",
      ciudad: "Montevideo",
    });
  });

  it("sin coma NO adivina: deja todo como dirección", () => {
    // Partir por el último espacio funcionaría en "Rivera 1234 Melo" y
    // fallaría en "Ruta 8 km 32", dejando "32" de ciudad.
    expect(separarDireccionCiudad("Ruta 8 km 32")).toEqual({ direccion: "Ruta 8 km 32" });
    expect(separarDireccionCiudad("Rivera 1234,")).toEqual({ direccion: "Rivera 1234" });
  });

  it("un mensaje con coma cierra el alta del cliente nuevo de una", async () => {
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            clase_receptor: "empresa",
            documento: "219999830019",
            cliente_ya_facturado: false,
            direccion_cliente: "Rivera 1234, Melo",
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).not.toBe("datos_cliente_nuevo");
    const sucursal = r.comprobante_borrador.cliente.sucursal;
    expect(sucursal.direccion).toBe("Rivera 1234");
    expect(sucursal.ciudad).toBe("Melo");
  });

  it("sin coma se repregunta SOLO la ciudad, no las dos cosas de nuevo", async () => {
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            clase_receptor: "empresa",
            documento: "219999830019",
            cliente_ya_facturado: false,
            direccion_cliente: "Ruta 8 km 32",
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).toBe("datos_cliente_nuevo");
    expect(r.pregunta).toBe("¿En qué ciudad?");
  });
});

describe("las correcciones revierten cualquier default", () => {
  const SESION = "+59899777888";

  /** Arranca una emisión que quedó lista con todos los defaults puestos. */
  async function conBorradorListo() {
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            sesion: SESION,
            clase_receptor: "empresa",
            documento: "219999830019",
            cliente_ya_facturado: true,
            items: [{ concepto: "Bolsa de portland", cantidad: 2, precio: 6500 }],
            montos_brutos: true,
            indicador_facturacion: 3,
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).toBe("confirmar");
    expect(r.comprobante_borrador.forma_pago).toBe(1);
    expect(r.comprobante_borrador.moneda).toBe("UYU");
    return ctx;
  }

  it('"es a crédito" cambia la forma de pago y abre el vencimiento', async () => {
    const ctx = await conBorradorListo();
    const r = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, forma_pago: 2 }, ctx)).content[0]!.text,
    );
    // Un default que no se puede revertir no es un default: es una decisión
    // nuestra. Y el crédito arrastra su propio paso, porque sin vencimiento la
    // venta no aparece en "¿quién me debe?".
    expect(r.paso).toBe("fecha_vencimiento");
    expect(r.comprobante_borrador.forma_pago).toBe(2);
  });

  it('"en dólares" cambia la moneda y pide la cotización', async () => {
    const ctx = await conBorradorListo();
    const r = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, moneda: "USD" }, ctx)).content[0]!.text,
    );
    expect(r.paso).toBe("tasa_cambio");
    expect(r.comprobante_borrador.moneda).toBe("USD");
  });

  it('"para el viernes" cambia la fecha', async () => {
    const ctx = await conBorradorListo();
    const r = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, fecha_emision: "28/08/2026" }, ctx)).content[0]!
        .text,
    );
    expect(r.paso).toBe("confirmar");
    expect(r.comprobante_borrador.fecha_emision).toBe("28/08/2026");
    expect(r.defaults_aplicados).not.toContain("fecha_emision");
  });

  it('"eran 3" cambia la cantidad que se había defaulteado', async () => {
    const { ctx } = makeCtx();
    const SESION_3 = "+59899999000";
    const primera = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            sesion: SESION_3,
            clase_receptor: "consumidor_final",
            sin_receptor: true,
            items: [{ concepto: "Bolsa de portland", precio: 6500 }],
            montos_brutos: true,
            indicador_facturacion: 3,
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(primera.comprobante_borrador.items[0].cantidad).toBe(1);
    expect(primera.defaults_aplicados).toContain("cantidad");

    const corregida = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION_3, items: [{ cantidad: "3" }] }, ctx)).content[0]!
        .text,
    );
    expect(corregida.comprobante_borrador.items[0].cantidad).toBe(3);
    expect(corregida.defaults_aplicados).not.toContain("cantidad");
  });
});

describe("➕ Otro ítem: del preview al ítem siguiente y de vuelta", () => {
  const SESION = "+59899121314";

  async function ctxConUnItem() {
    const { ctx } = makeCtx();
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            sesion: SESION,
            clase_receptor: "consumidor_final",
            sin_receptor: true,
            items: [{ concepto: "Café", cantidad: 1, precio: 100 }],
            montos_brutos: true,
            indicador_facturacion: 3,
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).toBe("confirmar");
    return ctx;
  }

  it("el botón del preview reabre concepto y precio, y vuelve al preview", async () => {
    const ctx = await ctxConUnItem();

    const abierto = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:otro" }, ctx)).content[0]!
        .text,
    );
    expect(abierto.paso).toBe("concepto");

    const conConcepto = JSON.parse(
      (
        await handleEmisionGuiada(
          { sesion: SESION, items: [{}, { concepto: "Medialuna" }] },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(conConcepto.paso).toBe("precio");

    const listo = JSON.parse(
      (
        await handleEmisionGuiada(
          { sesion: SESION, items: [{}, { precio: "50", cantidad: 3 }] },
          ctx,
        )
      ).content[0]!.text,
    );
    // El IVA no se vuelve a preguntar: ya hay criterio para el comprobante.
    expect(listo.paso).toBe("confirmar");
    expect(listo.comprobante_borrador.items).toHaveLength(2);
    expect(listo.comprobante_borrador.items[1]).toMatchObject({ precio: 50, cantidad: 3 });
  });

  it("tocar ➕ por error tiene salida: el flujo no se tranca", async () => {
    // El invariante del módulo. `otro_item` existía en parte para esto; al
    // sacarlo, la salida tiene que existir igual o el callejón vuelve.
    const ctx = await ctxConUnItem();
    await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:otro" }, ctx);

    const vuelto = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:cancelar" }, ctx)
      ).content[0]!.text,
    );
    expect(vuelto.paso).toBe("confirmar");
    expect(vuelto.comprobante_borrador.items).toHaveLength(1);
  });
});

describe("'✏️ Otra fecha': la única respuesta que retrocede el flujo", () => {
  it("no dice 'listo' mientras está preguntando la fecha", async () => {
    // El usuario descartó un dato que YA estaba resuelto (hoy, por default) y
    // todavía no dio el reemplazo. Sin el override, `siguientePaso` diría
    // "confirmar / listo" — o sea, le diríamos al agente "andá a emitir" en
    // medio de una pregunta abierta.
    const { ctx } = makeCtx();
    const SESION = "+59899151617";
    const listo = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            sesion: SESION,
            clase_receptor: "consumidor_final",
            sin_receptor: true,
            items: [{ concepto: "Café", cantidad: 1, precio: 100 }],
            montos_brutos: true,
            indicador_facturacion: 3,
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(listo.paso).toBe("confirmar");

    const otraFecha = JSON.parse(
      (await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:fecha:otra" }, ctx)).content[0]!
        .text,
    );
    expect(otraFecha.paso).toBe("fecha");
    expect(otraFecha.listo_para_requisitos).toBe(false);
    // Y no se le vuelve a ofrecer el botón "Hoy", que es justo lo que descartó.
    expect(otraFecha.pregunta).toContain("dd/mm/aaaa");

    const conFecha = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, fecha_emision: "20/08/2026" }, ctx)
      ).content[0]!.text,
    );
    expect(conFecha.paso).toBe("confirmar");
    expect(conFecha.comprobante_borrador.fecha_emision).toBe("20/08/2026");
  });
});
