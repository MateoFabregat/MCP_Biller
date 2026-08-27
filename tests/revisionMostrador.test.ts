// =============================================================================
// La revisión de UX de agosto 2026: el menú de mostrador, las intenciones que
// faltaban y el "estoy en medio de una carga" deducido del server.
//
// Los cuatro cambios que se verifican acá salieron de mirar transcripciones
// reales, y los cuatro tienen la misma forma: el sistema SABÍA la respuesta y
// no había ningún camino para llegar.
//
//   1. El orden del menú medía frecuencia de consulta en vez de urgencia de
//      mostrador. "Lo de siempre" —dos mensajes hasta un CFE— estaba oculto.
//   2. Buscar un comprobante ya emitido no tenía fila ni sinónimos.
//   3. "Me equivoqué con el recibo" armaba una nota de crédito.
//   4. `en_flujo` era un booleano que tenía que acordarse de mandar el modelo,
//      y cuando se olvidaba el webhook contestaba el menú en medio de una carga.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  OPCIONES_MENU,
  construirMenuInteractivo,
  interpretarMensaje,
  opcionesDisponibles,
} from "../src/kapso/menu.js";
import { claveSesion, BorradorStoreMemoria } from "../src/kapso/borradorStore.js";
import { decidirWebhook, normalizarEvento } from "../src/kapso/webhook.js";
import { construirPayloadInteractivo } from "../src/kapso/client.js";
import { handleMenuWhatsapp } from "../src/tools/menuWhatsapp.js";
import { ALL_TOOL_NAMES } from "../src/tools/register.js";
import { makeCtx } from "./helpers.js";

const W = { capabilityMode: "write_enabled" as const };
const R = { capabilityMode: "read_only" as const };

// ---------------------------------------------------------------------------
// 1. El orden de mostrador
// ---------------------------------------------------------------------------

describe("el menú se ordena por lo que hay que hacer YA, no por lo que más se consulta", () => {
  /**
   * El orden es una AFIRMACIÓN DE PRODUCTO, así que se escribe entero.
   *
   * Un test que solo chequeara "emitir es la 1" dejaría pasar cualquier
   * reordenamiento del resto — y el resto es donde está la decisión: la
   * analítica ("Plata en riesgo", "Mis clientes", "Cosas para atender") bajó a
   * ocultas para que suban las dos cosas que se hacen con un cliente enfrente.
   */
  const ORDEN_ESPERADO = [
    "menu:emitir",
    "menu:repetir",
    "menu:ver_comprobantes",
    "menu:cobranzas",
    "menu:cobro",
    "menu:dia",
    "menu:mes",
    "menu:enviar_pdf",
    "menu:anular",
    "menu:ayuda",
  ];

  it("las diez filas son exactamente estas y en este orden", () => {
    expect(opcionesDisponibles(W).map((o) => o.id)).toEqual(ORDEN_ESPERADO);
  });

  it("sigue entrando en los límites duros de una lista de WhatsApp", () => {
    const menu = construirMenuInteractivo(W);
    expect(() => construirPayloadInteractivo(menu)).not.toThrow();
    expect(menu.secciones.flatMap((s) => s.filas)).toHaveLength(10);
  });

  it("las secciones quedan CONTIGUAS, o el número deja de coincidir con la fila", () => {
    // `construirMenuInteractivo` agrupa y `construirMenuTexto` numera en el
    // orden del catálogo. Si un grupo se parte en dos pedazos, "mandá el 3"
    // apunta a una fila distinta de la tercera que el usuario ve — y eso es
    // justo lo que la numeración existe para evitar. Por eso "Mandar" y
    // "Anular" cambiaron de grupo cuando bajaron de fila.
    const grupos = construirMenuInteractivo(W).secciones.map((s) => s.titulo);
    expect(grupos).toEqual(["Facturar", "Plata", "Números", "Otros"]);
    expect(construirMenuInteractivo(W).secciones.flatMap((s) => s.filas).map((f) => f.id)).toEqual(
      ORDEN_ESPERADO,
    );
  });

  it('"Lo de siempre" dejó de ser invisible: es la fila 2', () => {
    // Era el camino más corto del producto y solo llegaba el que ya sabía la
    // fórmula. Una función que hay que adivinar no existe para casi nadie.
    const repetir = OPCIONES_MENU.find((o) => o.id === "menu:repetir");
    expect(repetir?.oculta).toBeUndefined();
    expect(interpretarMensaje("2", W).opcion?.id).toBe("menu:repetir");
  });

  it('"Registrar un cobro" quedó pegado a "¿Quién me debe?"', () => {
    // Ver el saldo sin poder tocarlo es lo que hace que la gente vuelva a la
    // planilla: el usuario veía la deuda y no tenía cómo decir "esta ya está".
    const ids = opcionesDisponibles(W).map((o) => o.id);
    expect(ids.indexOf("menu:cobro")).toBe(ids.indexOf("menu:cobranzas") + 1);
  });

  it("la analítica bajó a ocultas y el enrutador la entiende igual", () => {
    // Bajar de fila NO es sacar del catálogo. Esa distinción es la razón por la
    // que el menú puede tener diez filas sin que el producto tenga diez cosas.
    for (const [mensaje, id] of [
      ["plata en riesgo", "menu:riesgo"],
      ["mis mejores clientes", "menu:clientes"],
      ["hay algo rechazado", "menu:alertas"],
    ] as const) {
      const r = interpretarMensaje(mensaje, W);
      expect(r.opcion?.id, mensaje).toBe(id);
      expect(OPCIONES_MENU.find((o) => o.id === id)?.oculta, id).toBe(true);
    }
  });

  it("en modo consulta se caen las tres que escriben, sin dejar huecos", () => {
    const ids = opcionesDisponibles(R).map((o) => o.id);
    expect(ids).not.toContain("menu:emitir");
    expect(ids).not.toContain("menu:repetir");
    expect(ids).not.toContain("menu:cobro");
    // Y la numeración se recalcula: "1" en lectura es la primera que se ve.
    expect(interpretarMensaje("1", R).opcion?.id).toBe(ids[0]);
  });
});

// ---------------------------------------------------------------------------
// 2 y 3. Las intenciones que faltaban
// ---------------------------------------------------------------------------

describe("intenciones nuevas: ver, recibidos y deshacer un cobro", () => {
  it.each([
    ["mostrame las ultimas facturas", "menu:ver_comprobantes"],
    ["la ultima factura de perez", "menu:ver_comprobantes"],
    ["ver un comprobante", "menu:ver_comprobantes"],
    ["que facturas me llegaron", "menu:recibidos"],
    ["que me facturaron", "menu:recibidos"],
    ["me equivoque con el recibo", "menu:cancelar_recibo"],
    ["cancelar el recibo", "menu:cancelar_recibo"],
  ])('"%s" → %s', (mensaje, esperado) => {
    expect(interpretarMensaje(mensaje, W).opcion?.id).toBe(esperado);
  });

  it("un recibo mal hecho se CANCELA; una factura mal hecha se anula", () => {
    // "me equivoque" es sinónimo de `menu:anular`, así que la frase entera caía
    // ahí y el agente arrancaba a armar una nota de crédito por un recibo: un
    // documento fiscal de más por un problema que se resuelve con otra tool.
    // La desambiguación es por LONGITUD: el sinónimo largo contiene al corto,
    // así que gana sin producir un empate que haya que preguntar.
    const r = interpretarMensaje("me equivoque con el recibo", W);
    expect(r.opcion?.tools).toContain("biller_cancelar_recibo");
    expect(r.via).toBe("sinonimo");

    // Y la frase corta sigue yendo a anular, que es lo correcto.
    expect(interpretarMensaje("me equivoque con la factura", W).opcion?.id).toBe("menu:anular");
  });

  it('"mandame el pdf" le sigue ganando a "ver un comprobante"', () => {
    // El sinónimo "la ultima factura de" lleva la preposición pegada justo para
    // esto: sin ella es subcadena de "mandame el pdf de la ultima factura" y le
    // robaba el mensaje a la opción que efectivamente manda el archivo.
    expect(interpretarMensaje("mandame el pdf de la ultima factura", W).opcion?.id).toBe(
      "menu:enviar_pdf",
    );
    expect(interpretarMensaje("mandame el pedeefe de la ultima", W).opcion?.id).toBe(
      "menu:enviar_pdf",
    );
  });

  it("anular declara TAMBIÉN la tool que anula, no solo la que planifica", () => {
    // Con una sola, el agente sabía qué había que emitir y no tenía con qué.
    const anular = OPCIONES_MENU.find((o) => o.id === "menu:anular");
    expect(anular?.tools).toEqual(["biller_plan_anulacion", "biller_anular_comprobante"]);
    // El plan sigue PRIMERO: es el que distingue NC de ND y avisa si ya hay una
    // nota de crédito encima.
    expect(anular?.tools[0]).toBe("biller_plan_anulacion");
  });

  it("toda intención nueva apunta a tools que existen en el registro", () => {
    const registradas = new Set<string>(ALL_TOOL_NAMES);
    for (const id of ["menu:ver_comprobantes", "menu:recibidos", "menu:cancelar_recibo"]) {
      const opcion = OPCIONES_MENU.find((o) => o.id === id);
      expect(opcion, id).toBeDefined();
      for (const t of opcion!.tools) expect(registradas.has(t), `${id} → ${t}`).toBe(true);
    }
  });

  it("las frases del mostrador que caían en 'no entendí' ahora llegan", () => {
    for (const [mensaje, esperado] of [
      ["anula la ultima", "menu:anular"],
      ["borra la ultima factura", "menu:anular"],
      ["ventas de hoy", "menu:dia"],
      ["que vendi hoy", "menu:dia"],
      ["comparame junio con julio", "menu:mes"],
    ] as const) {
      const r = interpretarMensaje(mensaje, W);
      expect(r.opcion?.id, mensaje).toBe(esperado);
      expect(r.via, mensaje).not.toBe("desconocido");
    }
  });

  it('"comparame" no le roba las sucursales a la comparación de meses', () => {
    // La colisión que hubo que resolver: "comparame" entró como palabra suelta
    // en `menu:mes` (los meses no están en ningún catálogo, la evidencia es el
    // verbo) y eso se llevaba puesto "comparame los locales". Las frases largas
    // de sucursales lo CONTIENEN, así que ganan por longitud sin empatar.
    expect(interpretarMensaje("comparame los locales", W).opcion?.id).toBe("menu:sucursales");
    expect(interpretarMensaje("comparame junio con julio", W).opcion?.id).toBe("menu:mes");
  });

  it('"cuanto bendi oy" sigue yendo al mes, no al día', () => {
    // Las frases nuevas de `menu:dia` no le pueden sacar la transcripción de
    // audio que ya funcionaba: la coincidencia por tokens de `menu:mes` es
    // exacta (2/2) y la del día es parcial (2/3).
    expect(interpretarMensaje("cuanto bendi oy", W).opcion?.id).toBe("menu:mes");
  });
});

// ---------------------------------------------------------------------------
// El extractor conectado al enrutador
// ---------------------------------------------------------------------------

describe("un pedido de facturación enruta aunque no matchee ningún sinónimo", () => {
  it.each([
    "factura a perez, 2 bolsas de portland, 6500 cada una",
    "2 bolsas de portland a 6500 para perez",
    "perez 2 bolsas portland 6500",
    "una factura de 12000 a la panaderia",
    "ponele una factura a perez de 2 bolsas",
    "sale factura para perez",
  ])('"%s" → menu:emitir', (mensaje) => {
    const r = interpretarMensaje(mensaje, W);
    expect(r.opcion?.id).toBe("menu:emitir");
    expect(r.via).toBe("pedido_emision");
    expect(r.mostrar_menu).toBe(false);
  });

  it('"cobrale 1500 a martinez" es emitir, NO registrar un cobro', () => {
    // El riesgo era arreglarlo metiendo "cobrale" como token suelto en
    // `menu:emitir`: colisiona con "cobré una factura" de `menu:cobro`, que es
    // la intención OPUESTA (plata que ya entró). Lo resuelve la gramática.
    const r = interpretarMensaje("cobrale 1500 a martinez", W);
    expect(r.opcion?.id).toBe("menu:emitir");
    expect(r.opcion?.id).not.toBe("menu:cobro");
    expect(interpretarMensaje("cobre una factura", W).opcion?.id).toBe("menu:cobro");
  });

  it("devuelve los NOMBRES de los campos, nunca los valores", () => {
    // El concepto de un ítem es texto libre y su clave está en
    // CAMPOS_NO_CONFIABLES: devolverlo acá lo haría salir envuelto en
    // ⟦dato-no-confiable⟧ y volver a entrar así al borrador de un CFE.
    const r = interpretarMensaje("perez 2 bolsas portland 6500", W);
    expect(r.via).toBe("pedido_emision");
    expect(r.pedido_campos ?? []).toContain("concepto");
    expect(JSON.stringify(r)).not.toContain("portland");
    expect(JSON.stringify(r)).not.toContain("6500");
  });

  it("en modo consulta un pedido dice por qué no se puede, no abre el flujo", () => {
    const r = interpretarMensaje("perez 2 bolsas portland 6500", R);
    expect(r.via).toBe("no_disponible");
    expect(r.opcion?.id).toBe("menu:emitir");
    expect(r.respuesta_sugerida ?? "").toContain("solo de consulta");
  });

  it("el catálogo le gana SIEMPRE al extractor", () => {
    // El extractor corre último, con lo que el enrutador iba a tirar a "no
    // entendí". Nunca compite con una coincidencia del catálogo ni con el flujo.
    expect(interpretarMensaje("me pagaron la factura 1234", W).opcion?.id).toBe("menu:cobro");
    expect(interpretarMensaje("mandame el pdf de la ultima factura", W).via).toBe("sinonimo");
    expect(interpretarMensaje("2 bolsas a 6500 para perez", { ...W, en_flujo: true }).via).toBe(
      "flujo_emision",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. `en_flujo` sale del server
// ---------------------------------------------------------------------------

describe("estar en medio de una carga lo sabe el server, no el modelo", () => {
  const SESION = "59895923567";

  it("biller_menu_whatsapp lo deduce del borrador con solo la sesión", async () => {
    const { ctx, borradores } = makeCtx({ config: { capabilityMode: "write_enabled" } });

    const sinBorrador = JSON.parse(
      (await handleMenuWhatsapp({ mensaje: "que sean de 25kg", sesion: SESION }, ctx))
        .content[0]!.text,
    );
    expect(sinBorrador.interpretacion.via).toBe("desconocido");
    expect(sinBorrador.interpretacion.en_flujo).toBe(false);
    expect(sinBorrador.interpretacion.en_flujo_derivado).toBe(true);

    borradores.guardar(claveSesion(SESION), { clase_receptor: "consumidor_final" });

    const conBorrador = JSON.parse(
      (await handleMenuWhatsapp({ mensaje: "que sean de 25kg", sesion: SESION }, ctx))
        .content[0]!.text,
    );
    // El mismo mensaje, el mismo modelo, la misma llamada: lo único que cambió
    // es que el server tiene un borrador abierto. Antes esto dependía de que el
    // agente se acordara de mandar `en_flujo: true`.
    expect(conBorrador.interpretacion.via).toBe("flujo_emision");
    expect(conBorrador.interpretacion.en_flujo).toBe(true);
  });

  it("el booleano explícito sigue mandando por encima de lo que ve el server", async () => {
    const { ctx, borradores } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    borradores.guardar(claveSesion(SESION), { clase_receptor: "empresa" });

    const r = JSON.parse(
      (
        await handleMenuWhatsapp(
          { mensaje: "que sean de 25kg", sesion: SESION, en_flujo: false },
          ctx,
        )
      ).content[0]!.text,
    );
    expect(r.interpretacion.en_flujo).toBe(false);
    expect(r.interpretacion.en_flujo_derivado).toBe(false);
    expect(r.interpretacion.via).toBe("desconocido");
  });

  it("el webhook deja de autorresponder el menú en medio de una carga", () => {
    // ESTE ES EL CASO CARO. `desconocido` es una vía AUTORRESPONDIBLE: el
    // webhook contesta el menú entero, solo, sin pasar por el agente. Con una
    // emisión a medio cargar, "pará, eran 3 no 2" recibía diez opciones y la
    // carga se perdía.
    const borradores = new BorradorStoreMemoria();
    const opciones = {
      remitentesAutorizados: [SESION],
      capabilityMode: "write_enabled" as const,
      borradores,
    };
    const evento = normalizarEvento(eventoTexto("para, eran 3 no 2", SESION));

    const sinBorrador = decidirWebhook(evento, opciones);
    expect(sinBorrador.accion).toBe("responder");

    borradores.guardar(claveSesion(SESION), { clase_receptor: "consumidor_final" });

    const conBorrador = decidirWebhook(evento, opciones);
    // Delegar = se lo pasa al agente, que tiene el borrador y al humano
    // adelante. El webhook sigue sin ejecutar nada que toque plata: leer
    // nuestro propio estado no es ni una escritura ni una consulta a Biller.
    expect(conBorrador.accion).toBe("delegar");
    if (conBorrador.accion === "delegar") {
      expect(conBorrador.interpretacion.via).toBe("flujo_emision");
    }
  });

  it("sin store, el webhook se comporta exactamente como antes", () => {
    // El parámetro es opcional para no romper llamadores; que la ausencia no
    // cambie nada es parte del contrato.
    const d = decidirWebhook(normalizarEvento(eventoTexto("para, eran 3 no 2", SESION)), {
      remitentesAutorizados: [SESION],
      capabilityMode: "write_enabled",
    });
    expect(d.accion).toBe("responder");
  });

  it('"menú" saca del flujo aunque haya un borrador abierto', () => {
    // El flujo no captura la conversación: cambia qué significa el silencio del
    // catálogo, no lo que el catálogo entiende.
    const borradores = new BorradorStoreMemoria();
    borradores.guardar(claveSesion(SESION), { clase_receptor: "empresa" });
    const d = decidirWebhook(normalizarEvento(eventoTexto("menú", SESION)), {
      remitentesAutorizados: [SESION],
      capabilityMode: "write_enabled",
      borradores,
    });
    expect(d.accion).toBe("responder");
    if (d.accion === "responder") expect(d.interpretacion.via).toBe("saludo");
  });
});

/** Payload con la forma real de la Cloud API para un mensaje de texto. */
function eventoTexto(body: string, from: string): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "598...", phone_number_id: "5979075" },
              contacts: [{ profile: { name: "Mateo" }, wa_id: from }],
              messages: [
                { from, id: "wamid.HBg", timestamp: "1780000000", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}
