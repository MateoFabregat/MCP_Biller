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
  interpretarRespuestaLibre,
  separarDireccionCiudad,
  siguientePaso,
  sugiereDolares,
  tipoComprobanteSugerido,
  type EstadoEmision,
} from "../src/kapso/emision.js";
import { construirPayloadInteractivo } from "../src/kapso/client.js";
import { handleEmisionGuiada } from "../src/tools/emisionGuiada.js";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
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

  // --- El agujero en el MEDIO -------------------------------------------
  //
  // Regresión de un bug fiscal real. `siguientePaso` miraba SOLO el último
  // ítem, así que con `[{A,100}, {B sin precio}, {C,300}]` decía "confirmar,
  // listo" — el último estaba completo—. El borrador salía con dos líneas (A y
  // C, porque la del medio se filtra), y el agente, al que `completar` le pide
  // los conceptos "en el mismo orden en que la dijo", le ponía el concepto B a
  // la línea de C: un concepto equivocado sobre una línea de un CFE real ante
  // DGI, y nada avisaba.
  //
  // La propiedad que sostienen estos tres tests es una sola: el flujo no puede
  // decir "confirmar" con un ítem incompleto en NINGUNA posición.
  const BASE_ITEMS: EstadoEmision = {
    clase_receptor: "consumidor_final",
    sin_receptor: true,
    fecha_emision: HOY,
    moneda: "UYU",
    forma_pago: 1,
    montos_brutos: true,
    indicador_facturacion: 3,
  };

  it("un ítem sin precio EN EL MEDIO no deja pasar a confirmar", () => {
    const s = siguientePaso({
      ...BASE_ITEMS,
      items: [
        { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
        { concepto: "Portland", cantidad: 1 },
        { concepto: "Arena", cantidad: 1, precio: 300 },
      ],
    });
    expect(s.paso).toBe("precio");
    expect(s.listo).toBe(false);
    // Y la pregunta tiene que señalar CUÁL: "el ítem 2", no el último.
    expect(s.pregunta).toContain("ítem 2");
    expect(s.pregunta).not.toContain("ítem 3");
  });

  it("un ítem sin concepto EN EL MEDIO se pregunta por su precio, que es lo que el usuario reconoce", () => {
    const s = siguientePaso({
      ...BASE_ITEMS,
      items: [
        { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
        { cantidad: 1, precio: 250 },
        { concepto: "Arena", cantidad: 1, precio: 300 },
      ],
    });
    expect(s.paso).toBe("concepto");
    expect(s.listo).toBe(false);
    // El que carga desde el mostrador no reconoce "el ítem 2"; reconoce el
    // precio que acaba de decir. El concepto NO se puede ecoar (ver el
    // comentario de `siguientePaso`), así que el ancla es el número.
    expect(s.pregunta).toContain("250");
  });

  it("la cola cerrada se descarta solo si NO tiene nada: una línea con precio no se tira sola", () => {
    // El descarte de la cola existe para que abrir un ítem por error no trance
    // el flujo. Descartaba toda la cola SIN CONCEPTO, y eso se llevaba puesta
    // la línea con precio: `[{Café,1200},{precio:250}]` cerrado decía
    // "confirmar, listo" y facturaba $1.200 en vez de $1.450, sin una palabra.
    const conPlata = siguientePaso({
      ...BASE_ITEMS,
      items_cerrados: true,
      items: [
        { concepto: "Café", cantidad: 1, precio: 1200 },
        { cantidad: 1, precio: 250 },
      ],
    });
    expect(conPlata.listo).toBe(false);
    expect(conPlata.paso).toBe("concepto");
    // La pregunta la nombra por su plata, y la salida tocable dice cuánto saca:
    // un descarte de plata tiene que ser una decisión leída.
    expect(conPlata.pregunta).toContain("250");
    // El id lleva a QUÉ línea apunta —posición y precio—, para que un toque
    // tardío sobre un borrador ya cambiado no saque otra cosa.
    expect(conPlata.interactivo?.botones.map((b) => b.id)).toEqual([
      "emision:item:descartar:2:250",
    ]);
    expect(conPlata.interactivo?.botones[0]?.titulo).toContain("250");

    // La cola VACÍA se sigue descartando igual que siempre: es el ➕ tocado por
    // error, y no hay nada que perder.
    const colaVacia = siguientePaso({
      ...BASE_ITEMS,
      items_cerrados: true,
      items: [{ concepto: "Café", cantidad: 1, precio: 1200 }, {}],
    });
    expect(colaVacia.paso).toBe("confirmar");
    expect(colaVacia.listo).toBe(true);
  });

  it("el texto crudo NO contesta las preguntas de ítem: eso lo manda el agente", () => {
    // Se probó al revés —ramas de `concepto` y `precio` en
    // `interpretarRespuestaLibre`— y salió caro: "no sé" y "ni idea" quedaban
    // impresos como la descripción de una línea de un CFE, "bolsas 25kg" (que
    // lleva dígitos) trancaba la conversación en silencio, y cada frase que el
    // flujo usa para otra cosa había que enumerarla a mano. Que el server
    // parsee castellano es trabajo que el modelo ya hace bien: el camino es que
    // el agente mande `items: [{ concepto: "bolsas 25kg" }]`.
    //
    // Este test fija esa frontera para que no vuelva por accidente. El hueco
    // que deja está anotado en TODO_NEXT.md (P1), con los casos que tendría que
    // aguantar el día que se haga bien.
    for (const texto of ["medialunas", "60", "bolsas 25kg", "no sé"]) {
      expect(interpretarRespuestaLibre(texto, "concepto").paso, texto).toBe("ninguna");
      expect(interpretarRespuestaLibre(texto, "precio").paso, texto).toBe("ninguna");
    }
  });

  it("un 🗑️ que llega tarde no saca la línea equivocada NI se queda mudo", async () => {
    // El id del botón lleva la posición y el precio que decía el mensaje. Si el
    // borrador cambió en el medio, no se toca nada — y se contesta, que es la
    // otra mitad: un botón que no hace nada ni dice nada es el número mudo.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const SESION = "+59899151620";
    await handleEmisionGuiada(
      {
        sesion: SESION,
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        montos_brutos: true,
        indicador_facturacion: 3,
        items: [{ concepto: "Café", cantidad: 1, precio: 1200 }, { precio: "250" }],
      },
      ctx,
    );
    // El agente manda la descripción que el usuario dictó, y RECIÉN DESPUÉS
    // llega el 🗑️ que había quedado arriba en el chat.
    await handleEmisionGuiada(
      { sesion: SESION, items: [{ concepto: "Café" }, { concepto: "Medialunas" }] },
      ctx,
    );
    const tarde = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:descartar:2:250" }, ctx)
      ).content[0]!.text,
    );
    // Las dos líneas siguen: no se sacó ninguna.
    expect(tarde.comprobante_borrador.items).toHaveLength(2);
    expect(tarde.pregunta).toContain("ya no está");
    expect(tarde.warnings.join(" ")).toContain("NO se descartó nada");
  });

  it("el mismo estado pasando por '↩️ Volver así' tampoco pierde los $250", async () => {
    // Los dos arreglos no se pueden contradecir: `item_cancelar` conserva a
    // propósito el ítem con precio, y antes ponía `items_cerrados` — que era
    // justo lo que hacía que el flujo lo tirara. El botón que decía proteger la
    // plata la condenaba.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const SESION = "+59899151617";
    await handleEmisionGuiada(
      {
        sesion: SESION,
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        montos_brutos: true,
        indicador_facturacion: 3,
        items: [{ concepto: "Café", cantidad: 1, precio: 1200 }, { cantidad: 1, precio: "250" }],
      },
      ctx,
    );
    const vuelto = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:cancelar" }, ctx)
      ).content[0]!.text,
    );
    expect(vuelto.listo_para_requisitos).toBe(false);
    expect(vuelto.paso).toBe("concepto");
    expect(vuelto.pregunta).toContain("250");

    // Y si el usuario decide que esa línea no va, la saca LEYENDO el monto.
    const descartado = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:descartar" }, ctx)
      ).content[0]!.text,
    );
    expect(descartado.paso).toBe("confirmar");
    expect(descartado.comprobante_borrador.items).toEqual([
      { cantidad: 1, precio: 1200, indicador_facturacion: 3 },
    ]);
    expect(descartado.warnings.join(" ")).toContain("descartó");
  });

  it('"lo de siempre" con una BONIFICACIÓN al final no tranca ni la infla', async () => {
    // La bonificación se escribe al final de una factura de verdad, así que
    // repetirla dejaba el flujo pidiendo el precio de una línea que ya valía
    // $0: "0" no salía del paso, "listo" y "no va" tampoco, y el paso `precio`
    // no tiene botones — el número mudo. Y la única salida que funcionaba era
    // peor: contestar "60" convertía la bonificación en una línea de $60 y "lo
    // de siempre" salía $13.060 en vez de $13.000.
    const ventaCopiada = {
      id: 1,
      tipo_comprobante: 111,
      moneda: "UYU",
      total: 13_000,
      estado: "Aceptado DGI",
      fecha_emision: "2026-08-10 10:00:00",
      cliente: { documento: "210000000011", razon_social: "PEREZ SA" },
      montos_brutos: 1,
      items: [
        { cantidad: 2, concepto: "bolsas de harina", precio: 6500, indicador_facturacion: 3 },
        { cantidad: 1, concepto: "Bonificación", precio: 0, indicador_facturacion: 3 },
      ],
    };
    const { ctx } = makeCtx({ impl: () => [ventaCopiada] });
    const r = JSON.parse(
      (
        await handleEmisionGuiada(
          { sesion: "+59899151621", repetir_ultima_de: "210000000011", forma_pago: 1 },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.paso).toBe("confirmar");
    expect(r.listo_para_requisitos).toBe(true);
    // Y las DOS líneas viajan, la bonificada incluida y con su $0 intacto.
    expect(r.comprobante_borrador.items).toEqual([
      { cantidad: 2, precio: 6500, indicador_facturacion: 3 },
      { cantidad: 1, precio: 0, indicador_facturacion: 3 },
    ]);
  });

  it("una bonificación a $0 en el medio NO es un agujero: el flujo sigue de largo", () => {
    // La contracara de la regla: del ítem del medio importa lo que hace daño
    // —que el borrador no lo pueda mandar—, y una línea a $0 se manda. Frenar
    // ahí sería preguntarle el precio a algo que el usuario ya contestó, y peor
    // todavía: "0" no puede sacarlo de esa pregunta. Es el estado que deja
    // `repetir_ultima_de` sobre una factura con una línea bonificada.
    const s = siguientePaso({
      ...BASE_ITEMS,
      items: [
        { concepto: "Servicio", cantidad: 1, precio: 1000 },
        { concepto: "Bonificación", cantidad: 1, precio: 0 },
        { concepto: "Flete", cantidad: 1, precio: 300 },
      ],
    });
    expect(s.paso).toBe("confirmar");
    expect(s.listo).toBe(true);

    // Y del ÚLTIMO sí se sigue preguntando el precio, igual que siempre: ese
    // puede ser uno recién abierto al que todavía no se le puso nada.
    const alFinal = siguientePaso({
      ...BASE_ITEMS,
      items: [
        { concepto: "Servicio", cantidad: 1, precio: 1000 },
        { concepto: "Bonificación", cantidad: 1, precio: 0 },
      ],
    });
    expect(alFinal.paso).toBe("precio");
  });

  it("con items_cerrados el agujero del MEDIO tampoco pasa: la cola se descarta, el medio no", () => {
    // H1 de la revisión fiscal. `siguientePaso` filtraba TODOS los ítems sin
    // concepto cuando el usuario ya había tocado "listo", así que veía dos
    // ítems completos y decía "confirmar" — mientras `borradorComprobante`, que
    // no mira `items_cerrados`, cortaba en el del medio y mandaba UNA línea de
    // tres. El CFE salía por $100 en vez de $450 después de leer "ya tengo
    // todo".
    const conAgujero: EstadoEmision = {
      ...BASE_ITEMS,
      items_cerrados: true,
      items: [
        { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
        { cantidad: 1, precio: 250 },
        { concepto: "Arena", cantidad: 1, precio: 300 },
      ],
    };
    const s = siguientePaso(conAgujero);
    expect(s.listo).toBe(false);
    expect(s.paso).toBe("concepto");
    expect(s.pregunta).toContain("250");

    // Lo mismo con un ítem vacío en el medio, que además lleva salida tocable:
    // sin ella la pregunta no tendría cómo contestarse con un toque.
    const conVacio = siguientePaso({
      ...conAgujero,
      items: [
        { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
        {},
        { concepto: "Arena", cantidad: 1, precio: 300 },
      ],
    });
    expect(conVacio.listo).toBe(false);
    expect(conVacio.interactivo?.botones.map((b) => b.id)).toEqual(["emision:item:cancelar"]);

    // Y la COLA se sigue descartando igual que siempre: es lo que evita que
    // abrir un ítem por error trance el flujo para siempre.
    const conColaAbierta = siguientePaso({
      ...conAgujero,
      items: [{ concepto: "Bolsa de harina", cantidad: 2, precio: 100 }, {}],
    });
    expect(conColaAbierta.paso).toBe("confirmar");
    expect(conColaAbierta.listo).toBe(true);
  });

  it("dos agujeros se preguntan de a uno, en el orden en que el usuario los dijo", () => {
    const conDos: EstadoEmision = {
      ...BASE_ITEMS,
      items: [
        { concepto: "Bolsa de harina", cantidad: 2 },
        { concepto: "Portland", cantidad: 1, precio: 200 },
        { cantidad: 1, precio: 300 },
      ],
    };
    const primero = siguientePaso(conDos);
    expect(primero.paso).toBe("precio");
    expect(primero.pregunta).toContain("ítem 1");

    // Tapado el primero, aparece el segundo. Sin esto, un flujo que arregla un
    // agujero por vez podría declarar listo al tapar el primero.
    const items = [...conDos.items!];
    items[0] = { ...items[0]!, precio: 100 };
    const segundo = siguientePaso({ ...conDos, items });
    expect(segundo.paso).toBe("concepto");
    expect(segundo.listo).toBe(false);
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

  it("un ítem vacío EN EL MEDIO también tiene salida, y no se lleva la plata puesta", async () => {
    // Desde que el flujo dejó de esconder los agujeros del medio, un ítem que
    // quedó abierto ahí adentro tiene que poder descartarse de un toque: si no,
    // la pregunta por su descripción se repite sin salida tocable. Y el mismo
    // toque NO puede tirar un ítem que ya tiene precio: esa plata la dijo el
    // usuario.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const SESION = "+59899151617";
    const trancado = JSON.parse(
      (
        await handleEmisionGuiada(
          {
            sesion: SESION,
            clase_receptor: "consumidor_final",
            sin_receptor: true,
            montos_brutos: true,
            indicador_facturacion: 3,
            items_cerrados: true,
            items: [
              { concepto: "Café", cantidad: 1, precio: 100 },
              {},
              { concepto: "Medialuna", cantidad: 2, precio: 60 },
            ],
          },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(trancado.paso).toBe("concepto");
    expect(trancado.listo_para_requisitos).toBe(false);
    // El borrador corta en el agujero, y lo dice.
    expect(trancado.comprobante_borrador.items).toHaveLength(1);
    expect(trancado.warnings.join(" ")).toContain("medio cargar");

    const vuelto = JSON.parse(
      (
        await handleEmisionGuiada({ sesion: SESION, mensaje: "emision:item:cancelar" }, ctx)
      ).content[0]!.text,
    );
    // Descartado el vacío del medio, las dos líneas reales viajan — y en su
    // orden, que es lo que sostiene el copiado de conceptos por posición.
    expect(vuelto.paso).toBe("confirmar");
    expect(vuelto.comprobante_borrador.items).toEqual([
      { cantidad: 1, precio: 100, indicador_facturacion: 3 },
      { cantidad: 2, precio: 60, indicador_facturacion: 3 },
    ]);
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

// ---------------------------------------------------------------------------
// El pedido leído por el server: el resultado deja de depender del modelo
// ---------------------------------------------------------------------------

describe("biller_emision_guiada lee el texto del pedido por su cuenta", () => {
  const llamar = async (args: Record<string, unknown>, ctx: Parameters<typeof handleEmisionGuiada>[1]) =>
    JSON.parse((await handleEmisionGuiada(args, ctx)).content[0]!.text) as Record<string, any>;

  it("prellena el borrador aunque el modelo no haya mandado NINGÚN campo", async () => {
    // Éste es el punto entero: el agente pasa el texto tal cual y el server
    // saca cliente, cantidad, concepto y precio. Antes, si el modelo se
    // olvidaba de extraer, el flujo preguntaba las cuatro cosas de nuevo.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar({ mensaje: "facturale a perez 2 bolsas de portland a 6.500" }, ctx);

    expect(r.estado_entendido.nombre_cliente).toBe("perez");
    expect(r.estado_entendido.items[0]).toMatchObject({ concepto_cargado: true, cantidad: 2 });
    // Y el precio es SEIS MIL QUINIENTOS, no 6,5: `Number("6.500")` da 6.5 y
    // ese error no se ve hasta que el CFE está emitido.
    expect(r.estado_entendido.items[0].precio).toBe(6500);
  });

  // -------------------------------------------------------------------------
  // FISCAL-1, del otro lado de la costura: lo que el extractor lee de más tiene
  // que llegar al borrador, y lo que NO se pudo leer no puede terminar en
  // `listo`.
  // -------------------------------------------------------------------------
  it("un pedido de DOS ítems llega con las dos líneas al borrador", async () => {
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        mensaje: "facturale a gonzalez 3 cajas de clavos a 1200 y 2 bolsas de portland a 6500",
        clase_receptor: "empresa",
        documento: "210000000011",
        cliente_ya_facturado: true,
        montos_brutos: true,
        indicador_facturacion: 3,
      },
      ctx,
    );
    expect(r.estado_entendido.items).toHaveLength(2);
    expect(r.comprobante_borrador.items).toHaveLength(2);
    expect(r.comprobante_borrador.items[0]).toMatchObject({ cantidad: 3, precio: 1200 });
    expect(r.comprobante_borrador.items[1]).toMatchObject({ cantidad: 2, precio: 6500 });
    expect(r.listo_para_requisitos).toBe(true);
  });

  it("un precio que no entró en ninguna línea abre una pregunta, no un `listo`", async () => {
    // El freno obligatorio del hallazgo: con los $6.500 sin ítem al que
    // pertenecer, el flujo NO puede decir "andá a emitir". Antes emitía media
    // factura sin un warning.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        mensaje: "facturale a gonzalez 3 cajas de clavos a 1200 y portland a 6500",
        clase_receptor: "empresa",
        documento: "210000000011",
        cliente_ya_facturado: true,
        montos_brutos: true,
        indicador_facturacion: 3,
      },
      ctx,
    );
    expect(r.listo_para_requisitos).toBe(false);
    expect(r.paso).toBe("concepto");
    expect(r.warnings.join(" ")).toContain("6500");
    expect(r.warnings.join(" ")).toContain("NO emitas todavía");
    // Y la línea que SÍ se leyó no se pierde por el camino.
    expect(r.comprobante_borrador.items).toHaveLength(1);
  });

  it('"500 de pan" entra como importe y el flujo pregunta lo que corresponde', async () => {
    // Con la lectura vieja (cantidad 500), confirmar el precio con "500" daba
    // $250.000 por una bolsa de pan.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      { mensaje: "facturale 500 de pan a la panaderia", clase_receptor: "consumidor_final", sin_receptor: true },
      ctx,
    );
    expect(r.estado_entendido.items[0]).toMatchObject({ concepto_cargado: true, precio: 500 });
    // La cantidad la pone `aplicarDefaults` en 1, no el texto.
    expect(r.estado_entendido.items[0].cantidad).toBe(1);
    expect(r.defaults_aplicados).toContain("cantidad");
    // Concepto y precio ya están: lo que falta es el IVA, no la cantidad.
    expect(r.paso).toBe("iva");
  });

  it("lo que mandó el agente EXPLÍCITO nunca se pisa", async () => {
    // El texto dice 2 bolsas a 6.500; el agente dice 3 a 7.000 porque el
    // usuario lo corrigió después. Gana el dato explícito, siempre.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        mensaje: "facturale a perez 2 bolsas de portland a 6.500",
        nombre_cliente: "Panadería La Espiga",
        items: [{ concepto: "Bolsa de portland", cantidad: 3, precio: 7000 }],
      },
      ctx,
    );
    expect(r.estado_entendido.nombre_cliente).toBe("Panadería La Espiga");
    expect(r.estado_entendido.items[0]).toMatchObject({ cantidad: 3, precio: 7000 });
  });

  it("solo LLENA HUECOS: completa el precio que el agente no mandó", async () => {
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        mensaje: "facturale a perez 2 bolsas de portland a 6.500",
        items: [{ concepto: "Bolsa de portland", cantidad: 3 }],
      },
      ctx,
    );
    expect(r.estado_entendido.items[0].cantidad).toBe(3);
    expect(r.estado_entendido.items[0].precio).toBe(6500);
  });

  it("la ambigüedad de un precio llega como warning, no como un número callado", async () => {
    // "6.50" son 6,50 o 6.500 según quién lo escriba: cien veces de diferencia.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar({ mensaje: "facturale a perez 2 bolsas a 6.50" }, ctx);
    expect(r.warnings.join(" ")).toContain("CONFIRMALO");
  });

  it("las señales explícitas valen aunque el mensaje no sea un pedido entero", async () => {
    // "sin IVA" contestando una pregunta del flujo es exactamente esa señal, y
    // sale de una marca inequívoca, no de una gramática posicional.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        sesion: "59895923567",
        mensaje: "sin iva",
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        items: [{ concepto: "Café", cantidad: 1, precio: 100 }],
        indicador_facturacion: 3,
      },
      ctx,
    );
    expect(r.comprobante_borrador.montos_brutos).toBe(false);
    expect(r.paso).toBe("confirmar");
  });

  it("una CORRECCIÓN en medio del flujo no deja basura en el borrador", async () => {
    // "pará, eran 3 no 2" no es un pedido, así que el cliente y los ítems no se
    // tocan: un nombre sacado de una gramática posicional acá terminaría
    // impreso en un documento fiscal.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar({ mensaje: "pará, eran 3 no 2" }, ctx);
    expect(r.estado_entendido.nombre_cliente).toBeUndefined();
    expect(r.estado_entendido.items).toBeUndefined();
  });

  it("la moneda se convierte en PREGUNTA, no en decisión", async () => {
    // El extractor lee "en dólares" perfectamente. La tool igual pregunta: es
    // el único campo donde equivocarse cuesta 40x, y sale bien formado ante DGI.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        mensaje: "facturale a la barraca el flete, son 200 dolares",
        clase_receptor: "empresa",
        documento: "219999830019",
        cliente_ya_facturado: true,
      },
      ctx,
    );
    expect(r.paso).toBe("moneda");
  });

  it("un id de botón NO pasa por el extractor", async () => {
    // "emision:iva:3" no es castellano; interpretarlo con una gramática de
    // pedidos sería leer un id como si fuera una venta.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const r = await llamar({ mensaje: "emision:iva:3" }, ctx);
    expect(r.estado_entendido.indicador_facturacion).toBe(3);
    expect(r.estado_entendido.nombre_cliente).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// El perfil de la casa
//
// La regla fiscal (la unanimidad de `montos_brutos`) se prueba pura en
// `repetirUltima.test.ts`. Acá se prueba lo otro: que el perfil entre en la
// cadena de precedencia en el lugar exacto —debajo de todo lo que dijo el
// usuario, arriba de los defaults duros—, que salga escrito en el preview, y
// que sin historial el flujo se comporte EXACTAMENTE como antes de existir.
// ---------------------------------------------------------------------------

describe("el perfil de la casa: los defaults que salen del historial", () => {
  const llamar = async (args: Record<string, unknown>, ctx: Parameters<typeof handleEmisionGuiada>[1]) =>
    JSON.parse((await handleEmisionGuiada(args, ctx)).content[0]!.text) as Record<string, any>;

  /** Un día de hace `n` días, en el formato que devuelve la API. */
  const diasAtras = (n: number): string =>
    `${new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)} 10:00:00`;

  /** Una venta aceptada de la casa, adentro de la ventana de 90 días. */
  const cfe = (i: number, over: Record<string, unknown> = {}) => ({
    id: 500 + i,
    tipo_comprobante: 111,
    moneda: "UYU",
    total: 1000,
    estado: "Aceptado DGI",
    fecha_emision: diasAtras(i + 1),
    montos_brutos: 1,
    forma_pago: 1,
    cliente: { documento: "210000000011", razon_social: "PEREZ SA" },
    items: [{ cantidad: 1, concepto: "bolsas de harina", precio: 1000, indicador_facturacion: 3 }],
    ...over,
  });

  /**
   * Una API con historial: el listado devuelve todo, el detalle (por id) uno.
   *
   * La distinción importa porque el perfil hace las DOS consultas: el listado no
   * trae ítems, y la tasa de IVA vive en los ítems.
   */
  const apiConHistorial = (comprobantes: Array<Record<string, unknown>>) => (opts: any) => {
    const id = opts?.query?.id;
    if (id !== undefined) return comprobantes.filter((c) => String(c["id"]) === String(id));
    return comprobantes;
  };

  const CASA_CON_IVA_INCLUIDO = Array.from({ length: 5 }, (_, i) => cfe(i));

  /** "Cliente conocido, línea completa": todo lo que el usuario dijo, y nada más. */
  const PEDIDO_COMPLETO = {
    clase_receptor: "empresa" as const,
    documento: "210000000011",
    cliente_ya_facturado: true,
    items: [{ concepto: "bolsas de harina", cantidad: 2, precio: 6500 }],
  };

  it("cliente conocido + línea completa + perfil = CERO preguntas", async () => {
    // El objetivo entero de la feature, medido: con las cinco últimas facturas
    // coincidiendo, la única pregunta que quedaba en el flujo desaparece y el
    // usuario pasa directo al preview.
    const { ctx } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    expect(r.paso).toBe("confirmar");
    expect(r.listo_para_requisitos).toBe(true);
    expect(r.defaults_aplicados).toContain("montos_brutos");
    expect(r.defaults_aplicados).toContain("indicador_facturacion");
    expect(r.perfil_casa).toMatchObject({ derivado: true, muestras: 5 });
    expect(r.perfil_casa.campos).toContain("montos_brutos");
    // Y el valor derivado es el que va al CFE, no una etiqueta decorativa.
    expect(r.comprobante_borrador.montos_brutos).toBe(true);
    expect(r.comprobante_borrador.items[0].indicador_facturacion).toBe(3);
  });

  it("sin historial, la conducta es IDÉNTICA a la de antes: se pregunta el IVA", async () => {
    // La propiedad que hace que esto se pueda mergear sin miedo: cuando el
    // perfil no existe —empresa nueva, API muda, cuatro facturas— no cambia
    // absolutamente nada.
    const { ctx } = makeCtx({ impl: () => [], config: { capabilityMode: "write_enabled" } });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    expect(r.paso).toBe("iva");
    expect(r.listo_para_requisitos).toBe(false);
    expect(r.comprobante_borrador.montos_brutos).toBeUndefined();
    expect(r.defaults_aplicados).not.toContain("montos_brutos");
  });

  it("cuatro facturas iguales tampoco alcanzan: el flujo sigue preguntando", async () => {
    const { ctx } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO.slice(0, 4)),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);
    expect(r.paso).toBe("iva");
    expect(r.perfil_casa).toMatchObject({ muestras: 4 });
    expect(r.perfil_casa.campos).toEqual([]);
  });

  it("una factura fuera de línea rompe la unanimidad y devuelve la pregunta", async () => {
    const mezcla = [...CASA_CON_IVA_INCLUIDO.slice(0, 4), cfe(4, { montos_brutos: 0 })];
    const { ctx } = makeCtx({
      impl: apiConHistorial(mezcla),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);
    // Y la pregunta que vuelve es la CHICA: la tasa sigue siendo unánime, así
    // que no se repregunta el paso fusionado entero sino solo la mitad que el
    // perfil no pudo contestar. Media pregunta ahorrada es una mejora real.
    expect(r.paso).toBe("precio_incluye_iva");
    expect(r.comprobante_borrador.montos_brutos).toBeUndefined();
    expect(r.comprobante_borrador.items[0].indicador_facturacion).toBe(3);
  });

  // -------------------------------------------------------------------------
  // FISCAL-4: la unanimidad de `montos_brutos` se mide sobre TODA la ventana.
  //
  // Los otros campos salen de los cinco comprobantes DETALLADOS porque la tasa
  // de IVA vive en los ítems. `montos_brutos` no: viene en el listado, y los
  // ~200 de la ventana de 90 días ya están en memoria. Mirando solo cinco, una
  // ferretería 80/20 tenía una chance nada despreciable de que sus últimas
  // cinco coincidieran por casualidad — y ahí una racha pasaba por costumbre.
  // -------------------------------------------------------------------------
  it("los 5 últimos coinciden pero el 6º de la ventana difiere: NO deriva", async () => {
    // Exactamente el caso del hallazgo. Los cinco que se detallan son unánimes;
    // el sexto —que está en la ventana y nadie miraba— dice lo contrario.
    const ventana = [...CASA_CON_IVA_INCLUIDO, cfe(9, { id: 599, montos_brutos: 0 })];
    const { ctx } = makeCtx({
      impl: apiConHistorial(ventana),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    expect(r.perfil_casa.campos).not.toContain("montos_brutos");
    expect(r.comprobante_borrador.montos_brutos).toBeUndefined();
    // Se sigue preguntando la mitad que el perfil no pudo contestar; la tasa,
    // que SÍ se deriva de los cinco detallados, sigue derivándose.
    expect(r.paso).toBe("precio_incluye_iva");
    expect(r.comprobante_borrador.items[0].indicador_facturacion).toBe(3);
  });

  it("y lo dice contando la ventana entera, no cinco", async () => {
    const ventana = [...CASA_CON_IVA_INCLUIDO, ...Array.from({ length: 7 }, (_, i) => cfe(10 + i))];
    const { ctx } = makeCtx({
      impl: apiConHistorial(ventana),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    expect(r.comprobante_borrador.montos_brutos).toBe(true);
    // Los doce, no los cinco: el porqué del default tiene que decir sobre qué
    // evidencia se tomó, o no es auditable.
    expect(r.perfil_casa.porque.join(" ")).toContain("12 CFE aceptados de la ventana");
  });

  it("una venta RECHAZADA de la ventana no vota", async () => {
    // El criterio del proyecto: solo "Aceptado DGI". Un comprobante rechazado no
    // facturó nada, así que no describe la costumbre de la casa — y si votara,
    // bastaría un rechazo con otro criterio para tapar el perfil de siempre.
    const ventana = [
      ...CASA_CON_IVA_INCLUIDO,
      cfe(9, { id: 598, montos_brutos: 0, estado: "Rechazado DGI" }),
    ];
    const { ctx } = makeCtx({
      impl: apiConHistorial(ventana),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);
    expect(r.comprobante_borrador.montos_brutos).toBe(true);
  });

  it("LA RESPUESTA DEL USUARIO PISA AL PERFIL, siempre", async () => {
    // La casa factura con IVA incluido en las últimas cinco; esta venta no. Lo
    // que dijo el usuario gana sin discutir, y el perfil deja de figurar como
    // el origen de ese campo.
    const { ctx } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar(
      { sesion: "59895923567", ...PEDIDO_COMPLETO, montos_brutos: false },
      ctx,
    );
    expect(r.comprobante_borrador.montos_brutos).toBe(false);
    expect(r.defaults_aplicados).not.toContain("montos_brutos");
    expect(r.perfil_casa.campos).not.toContain("montos_brutos");
  });

  it("EL PERFIL NO SE ESCRIBE EN EL BORRADOR GUARDADO: solo como cache derivado", async () => {
    // Mismo criterio que los defaults de siempre. Si `montos_brutos: true`
    // quedara guardado, "el perfil lo supuso" y "el usuario lo dijo" serían
    // indistinguibles la próxima vez que se lea el borrador — y `fusionarEstado`
    // trata lo guardado como base.
    const { ctx, borradores } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    const guardado = borradores.leer(r.sesion.id)!;
    expect(guardado.estado.montos_brutos).toBeUndefined();
    expect(guardado.estado.indicador_facturacion).toBeUndefined();
    // Lo que SÍ queda es el perfil, bajo su propia clave y marcado como derivado.
    expect(guardado.estado.perfil_casa).toMatchObject({ derivado: true, muestras: 5 });
  });

  it("se busca UNA vez por sesión: el segundo mensaje no vuelve a consultar", async () => {
    const { ctx, getMock } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled" },
    });
    await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);
    const consultasPrimerMensaje = getMock.mock.calls.length;
    expect(consultasPrimerMensaje).toBeGreaterThan(0);

    // El segundo mensaje agrega un ítem: mismo estado, misma sesión, perfil ya
    // cacheado. No tiene por qué costar ni una consulta más.
    await llamar(
      {
        sesion: "59895923567",
        items: [
          { concepto: "bolsas de harina", cantidad: 2, precio: 6500 },
          { concepto: "levadura", cantidad: 1, precio: 300 },
        ],
      },
      ctx,
    );
    expect(getMock.mock.calls.length).toBe(consultasPrimerMensaje);
  });

  it("no se busca antes de que haya una línea con precio", async () => {
    // El embudo dice que la mayoría de las conversaciones se abandona antes de
    // cargar el primer precio. Consultar noventa días de historial en cada
    // "quiero facturar" sería gastar el rate limit de la empresa en
    // conversaciones que no van a existir.
    const { ctx, getMock } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", clase_receptor: "empresa" }, ctx);
    expect(r.paso).toBe("cliente");
    expect(r.perfil_casa).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("si el historial no se puede leer, el flujo sigue: se pregunta como siempre", async () => {
    const { ctx } = makeCtx({
      impl: () => {
        throw new Error("API caída");
      },
      config: { capabilityMode: "write_enabled" },
    });
    const r = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);
    expect(r.paso).toBe("iva");
    expect(r.perfil_casa).toBeNull();
    expect(r.warnings.join(" ")).toContain("historial");
  });

  it("el perfil no puede inyectarse desde afuera", async () => {
    // `perfil_casa` no está en el schema de entrada, y no es un olvido: si un
    // agente (o un texto de un comprobante que el agente copió) pudiera
    // mandarlo, tendría una forma de fijar `montos_brutos` sin que ninguna
    // factura de la empresa lo respalde.
    const { ctx } = makeCtx({ impl: () => [], config: { capabilityMode: "write_enabled" } });
    const r = await llamar(
      {
        sesion: "59895923567",
        ...PEDIDO_COMPLETO,
        perfil_casa: { derivado: true, muestras: 99, montos_brutos: true, detalles: [] },
      },
      ctx,
    );
    expect(r.paso).toBe("iva");
    expect(r.comprobante_borrador.montos_brutos).toBeUndefined();
  });

  it("EL DEFAULT DEL PERFIL SALE ESCRITO EN LA LÍNEA DE SUPUESTOS DEL PREVIEW", async () => {
    // La contrapartida de no preguntar: lo que el sistema decidió solo tiene
    // que estar en lo único que el usuario lee antes de que exista un CFE.
    //
    // No hizo falta tocar el render para esto, y el test es lo que lo prueba:
    // `describirSupuestos` arma la línea desde los campos del PAYLOAD, y el
    // perfil llena esos mismos campos en `comprobante_borrador`. El camino es
    // el mismo por el que ya salían la fecha y la forma de pago.
    const { ctx } = makeCtx({
      impl: apiConHistorial(CASA_CON_IVA_INCLUIDO),
      config: { capabilityMode: "write_enabled", environment: "test", writeEnabled: true },
      postResponse: { id: 99 },
    });
    const guiada = await llamar({ sesion: "59895923567", ...PEDIDO_COMPLETO }, ctx);

    // El agente arma el comprobante desde el borrador tal cual, sin conceptos
    // (los completa el server desde la sesión) y sin tocar el criterio de IVA.
    const dry = await handleEmitirComprobante(
      {
        sesion: guiada.sesion.id,
        comprobante: { ...guiada.comprobante_borrador, sucursal: 6, cliente: "-" },
      },
      ctx,
    );
    expect(dry.isError).not.toBe(true);
    const resumen = String((dry.structuredContent as Record<string, any>).resumen);

    expect(resumen).toContain("precios con IVA incluido");
    expect(resumen).toContain("Contado");
    // Y el total es el de un precio CON IVA adentro: 2 × 6500 = 13.000 finales,
    // no 15.860. Es exactamente el 22% que este default mueve.
    expect(resumen).toContain("$13.000");
  });
});

// ---------------------------------------------------------------------------
// FISCAL-2: la marca de precio AMBIGUO tiene que llegar al preview.
//
// `extraerPedido.ts` la viene poniendo desde siempre, con un comentario que
// dice "TIENE QUE SOBREVIVIR HASTA EL PREVIEW". No sobrevivía: se perdía al
// volcarse al estado, y el usuario recibía "$13" sin una palabra sobre que
// probablemente eran $13.000. Cien veces de diferencia, en el único mensaje que
// el humano lee antes de que exista un CFE.
//
// Estos tests recorren la costura entera —extractor → estado → store → payload
// → resumen— porque el hallazgo era justo que cada pieza andaba y el camino no.
// ---------------------------------------------------------------------------

describe("un precio ambiguo sobrevive hasta el resumen de confirmación", () => {
  const SESION = "59895923567";

  const llamar = async (args: Record<string, unknown>, ctx: Parameters<typeof handleEmisionGuiada>[1]) =>
    JSON.parse((await handleEmisionGuiada(args, ctx)).content[0]!.text) as Record<string, any>;

  it("del texto al store: la marca se GUARDA, no solo se avisa", async () => {
    const { ctx, borradores } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    await llamar({ sesion: SESION, mensaje: "facturale a perez 2 bolsas a 6.50" }, ctx);

    const guardado = borradores.leer(borradores.clave(SESION))?.estado;
    expect(guardado?.items?.[0]?.precio).toBe(6.5);
    expect(guardado?.items?.[0]?.precio_ambiguo).toBe(true);
  });

  it("sobrevive a los mensajes siguientes del flujo", async () => {
    // El motivo por el que un warning no alcanzaba: la confirmación ocurre dos
    // o tres mensajes después, y el warning ya se lo llevó el viento.
    const { ctx, borradores } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    await llamar({ sesion: SESION, mensaje: "facturale a perez 2 bolsas a 6.50" }, ctx);
    await llamar({ sesion: SESION, mensaje: "emision:iva:3" }, ctx);
    const r = await llamar({ sesion: SESION, mensaje: "emision:montos_brutos:si" }, ctx);

    expect(borradores.leer(borradores.clave(SESION))?.estado.items?.[0]?.precio_ambiguo).toBe(true);
    // Y el agente lo puede ver en el espejo: es un booleano nuestro, no texto
    // de nadie, así que sí vuelve en la respuesta.
    expect(r.estado_entendido.items[0].precio_ambiguo).toBe(true);
  });

  it("EL RESUMEN DEL PREVIEW LLEVA LA ADVERTENCIA, escrita", async () => {
    // El cierre del hallazgo. Un precio ambiguo no puede llegar a un preview
    // que solo diga "$13".
    const { ctx } = makeCtx({
      config: { capabilityMode: "write_enabled", environment: "test", writeEnabled: true },
      postResponse: { id: 99 },
    });
    const guiada = await llamar(
      {
        sesion: SESION,
        mensaje: "facturale a perez 2 bolsas a 6.50",
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        montos_brutos: true,
        indicador_facturacion: 3,
      },
      ctx,
    );
    expect(guiada.listo_para_requisitos).toBe(true);

    const dry = await handleEmitirComprobante(
      {
        sesion: guiada.sesion.id,
        comprobante: { ...guiada.comprobante_borrador, sucursal: 6, cliente: "-" },
      },
      ctx,
    );
    expect(dry.isError).not.toBe(true);
    const structured = dry.structuredContent as Record<string, any>;
    const resumen = String(structured.resumen);

    // El invariante: si llegó a `listo`, el resumen tiene la advertencia.
    expect(resumen).toContain("⚠️");
    expect(resumen).toContain("El precio");
    expect(resumen).toContain("$6,50");
    expect(resumen).toContain("ANTES de emitir");
    // Y el agente también lo recibe, que es quien puede repreguntar.
    expect((structured.warnings as string[]).join(" ")).toContain("AMBIGUO");
  });

  it("un precio corregido a mano APAGA la advertencia", async () => {
    // El otro lado: una marca que no se puede apagar es ruido, y el ruido hace
    // que se dejen de leer las advertencias que sí importan.
    const { ctx, borradores } = makeCtx({
      config: { capabilityMode: "write_enabled", environment: "test", writeEnabled: true },
      postResponse: { id: 99 },
    });
    const primera = await llamar(
      {
        sesion: SESION,
        mensaje: "facturale a perez 2 bolsas a 6.50",
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        montos_brutos: true,
        indicador_facturacion: 3,
      },
      ctx,
    );
    // "no, son 6500"
    const guiada = await llamar({ sesion: SESION, items: [{ precio: "6500" }] }, ctx);

    expect(borradores.leer(borradores.clave(SESION))?.estado.items?.[0]?.precio_ambiguo).toBe(false);
    expect(guiada.estado_entendido.items[0].precio_ambiguo).toBeUndefined();

    const dry = await handleEmitirComprobante(
      {
        sesion: guiada.sesion.id,
        comprobante: { ...guiada.comprobante_borrador, sucursal: 6, cliente: "-" },
      },
      ctx,
    );
    const resumen = String((dry.structuredContent as Record<string, any>).resumen);
    expect(resumen).toContain("$13.000");
    expect(resumen).not.toContain("admite otra lectura");
    expect(primera.comprobante_borrador.items[0].precio).toBe(6.5);
  });
});

// ---------------------------------------------------------------------------
// LA SESIÓN ES DE QUIEN ESCRIBE, NO DE QUIEN EL MODELO DIGA.
//
// El agujero: la clave del borrador salía de `sesion`, un parámetro que elige
// el modelo y que acepta un teléfono crudo. La barrera de entrada ya había
// verificado quién escribía y ese dato se descartaba. Con dos números en la
// allowlist de la MISMA empresa —el caso normal, dueño más contador— alcanzaba
// con "seguí la factura que estaba armando el 099…" para leer el borrador del
// otro; y como los ítems se fusionan por posición, para inyectarle una línea
// que el otro iba a ver en su preview mezclada con lo suyo.
//
// La sal del store cerraba el cruce ENTRE empresas y no podía cerrar este: las
// dos partes son la misma empresa, o sea la misma sal.
// ---------------------------------------------------------------------------

describe("el borrador de la emisión es del remitente verificado", () => {
  const DUENO = "59899111000";
  const CONTADOR = "59899222000";

  /** Canal de WhatsApp abierto: dos números autorizados en la misma empresa. */
  const conCanal = () =>
    makeCtx({
      config: {
        kapso: {
          apiKey: "kapso_key_de_prueba",
          baseUrl: "https://api.kapso.ai",
          phoneNumberId: "597907523413541",
          destinatariosPermitidos: [DUENO, CONTADOR],
        },
      },
    });

  const llamar = async (args: Record<string, unknown>, ctx: Parameters<typeof handleEmisionGuiada>[1]) =>
    JSON.parse((await handleEmisionGuiada(args, ctx)).content[0]!.text) as Record<string, any>;

  it("un remitente NO puede leer el borrador de otro de su misma empresa", async () => {
    const { ctx, borradores } = conCanal();
    await llamar({ remitente: DUENO, mensaje: "facturale a perez 2 bolsas de portland a 6500" }, ctx);
    // El concepto NO vuelve en la respuesta —lo envolvería la barrera de
    // salida—, así que el borrador ajeno se mira en el store.
    expect(JSON.stringify(borradores.leer(borradores.clave(DUENO))!.estado)).toContain("portland");

    // El contador pide explícitamente la sesión del dueño.
    const espiada = await handleEmisionGuiada({ remitente: CONTADOR, sesion: DUENO }, ctx);
    expect(espiada.isError).toBe(true);
    const error = JSON.parse(espiada.content[0]!.text).error;
    expect(error.kind).toBe("autorizacion");
    expect(error.motivo).toBe("sesion_ajena");
    // El mensaje va dirigido al modelo y le cierra las dos salidas.
    expect(error.message).toContain("NO reintentes con otro número");
    // Y no se filtra nada del borrador ajeno, ni el número entero de su dueño.
    expect(error.message).not.toContain(DUENO);
    expect(JSON.stringify(espiada)).not.toContain("portland");
  });

  it("tampoco con el `sesion.id` opaco del otro, que es 24 hex válidos", async () => {
    const { ctx } = conCanal();
    const propio = await llamar({ remitente: DUENO, mensaje: "facturale a perez a 6500" }, ctx);
    const idAjeno = propio.sesion.id as string;
    expect(idAjeno).toMatch(/^[0-9a-f]{24}$/);

    const res = await handleEmisionGuiada({ remitente: CONTADOR, sesion: idAjeno }, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.motivo).toBe("sesion_ajena");
  });

  it("no puede INYECTARLE ítems al borrador de otro", async () => {
    // El caso caro: `fusionarItems` fusiona por posición, así que una línea
    // ajena entra sin borrar nada y aparece en el preview del otro mezclada con
    // lo suyo. Un CFE con ítems que el emisor no cargó.
    const { ctx, borradores } = conCanal();
    await llamar({ remitente: DUENO, mensaje: "facturale a perez 2 bolsas a 6500" }, ctx);

    const res = await handleEmisionGuiada(
      { remitente: CONTADOR, sesion: DUENO, items: [{}, { concepto: "flete", precio: 9999 }] },
      ctx,
    );
    expect(res.isError).toBe(true);

    const delDueno = borradores.leer(borradores.clave(DUENO))!.estado;
    expect(delDueno.items).toHaveLength(1);
    expect(JSON.stringify(delDueno)).not.toContain("flete");
  });

  it("`reiniciar` ajeno no borra nada: el chequeo va ANTES de tocar el store", async () => {
    const { ctx, borradores } = conCanal();
    await llamar({ remitente: DUENO, mensaje: "facturale a perez 2 bolsas a 6500" }, ctx);
    const antes = borradores.leer(borradores.clave(DUENO))!.revision;

    const res = await handleEmisionGuiada({ remitente: CONTADOR, sesion: DUENO, reiniciar: true }, ctx);
    expect(res.isError).toBe(true);
    expect(borradores.leer(borradores.clave(DUENO))?.revision).toBe(antes);
  });

  it("el flujo normal no se rompe: mismo remitente, dos mensajes, un borrador", async () => {
    const { ctx } = conCanal();
    const uno = await llamar(
      { remitente: DUENO, mensaje: "facturale a perez 2 bolsas de portland a 6500" },
      ctx,
    );
    expect(uno.sesion.activa).toBe(true);

    // Sin mandar 'sesion' siquiera: el server ya sabe de quién es el borrador.
    const dos = await llamar({ remitente: DUENO, mensaje: "emision:iva:3" }, ctx);
    expect(dos.sesion.id).toBe(uno.sesion.id);
    expect(dos.estado_entendido.items[0].precio).toBe(6500);
    expect(dos.sesion.recuperado_del_store.length).toBeGreaterThan(0);
  });

  it("mandar 'sesion' con el propio número sigue andando, en cualquier formato", async () => {
    const { ctx } = conCanal();
    const uno = await llamar({ remitente: DUENO, sesion: DUENO, mensaje: "facturale a perez a 6500" }, ctx);
    const dos = await llamar(
      { remitente: DUENO, sesion: `+${DUENO.slice(0, 3)} ${DUENO.slice(3)}`, mensaje: "emision:iva:3" },
      ctx,
    );
    expect(dos.sesion.id).toBe(uno.sesion.id);
  });

  it("con el canal abierto y SIN remitente no se abre ninguna sesión", async () => {
    // No debería llegar acá nunca —la barrera rechaza antes del handler—, y por
    // eso mismo se rechaza en vez de degradar a `sesion`: si alguien registra
    // esta tool sin barrera, el modo de falla es "no contesta", no "vuelve el
    // agujero".
    const { ctx } = conCanal();
    const res = await handleEmisionGuiada({ sesion: DUENO, mensaje: "facturale a perez a 6500" }, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error.message).toContain("Falta 'remitente'");
  });

  it("SIN Kapso configurado, 'sesion' sigue valiendo tal cual (modo Claude Desktop)", async () => {
    // Ahí no hay canal no confiable: el que abre el server es el dueño de la
    // máquina. Pedirle que se identifique con un teléfono no protege de nada.
    const { ctx } = makeCtx();
    const uno = await llamar({ sesion: "59899121314", mensaje: "facturale a perez 2 bolsas a 6500" }, ctx);
    const dos = await llamar({ sesion: "59899121314", mensaje: "emision:iva:3" }, ctx);
    expect(dos.sesion.id).toBe(uno.sesion.id);
    expect(dos.sesion.recuperado_del_store.length).toBeGreaterThan(0);
  });
});
