// =============================================================================
// Regresiones del enrutador y de la emisión guiada.
//
// Cada test de este archivo es un mensaje REAL que el sistema contestaba mal,
// encontrado en una auditoría de 155 mensajes escritos como los escribe un
// almacenero uruguayo. El código de arriba de cada bloque (A1, A4, A6, B3, B5,
// B7) es el del informe.
//
// Los de la sección A son los peores: no fallaban, contestaban BIEN OTRA
// PREGUNTA. En un canal donde el usuario no ve que hubo una decisión, ese es el
// modo de falla más caro que existe.
// =============================================================================

import { describe, expect, it } from "vitest";
import { interpretarMensaje } from "../src/kapso/menu.js";
import { siguientePaso, type EstadoEmision } from "../src/kapso/emision.js";
import { parsearCantidad } from "../src/services/importe.js";
import { resolver } from "../src/services/resolver.js";

const W = { capabilityMode: "write_enabled" as const };
const R = { capabilityMode: "read_only" as const };

// --- A1: una negación no puede enrutar a una tool de ESCRITURA --------------

describe("A1 · las negaciones no disparan escrituras", () => {
  it.each(["no me pagaron todavia", "todavia no me pagaron", "no, no me pagaron"])(
    '"%s" NO va a "Registrar un cobro"',
    (mensaje) => {
      // El usuario avisa que NO le pagaron; el sistema lo llevaba a emitir un
      // recibo, con confianza total y sin warning.
      const r = interpretarMensaje(mensaje, W);
      expect(r.opcion?.id).not.toBe("menu:cobro");
      expect(r.opcion?.tools ?? []).not.toContain("biller_crear_recibo");
    },
  );

  it("la frase afirmativa sí sigue llegando", () => {
    expect(interpretarMensaje("me pagaron la factura", W).opcion?.id).toBe("menu:cobro");
  });
});

// --- A4: dos intenciones en un mensaje se preguntan, no se eligen -----------

describe("A4 · dos preguntas en un mensaje son un empate", () => {
  it.each([
    "cuanto compre y cuanto vendi",
    "cuanto vendi y cuanto compre",
    "quien me debe y cuanto facture este mes",
  ])('"%s" es ambiguo', (mensaje) => {
    // Se resolvía por UN carácter de diferencia entre los dos sinónimos, en
    // silencio y con confianza 1.
    const r = interpretarMensaje(mensaje, W);
    expect(r.via).toBe("ambiguo");
    expect(r.candidatas?.length ?? 0).toBeGreaterThan(1);
  });

  it("el caso ANIDADO sigue resolviéndose sin preguntar", () => {
    // "nota de credito" tiene que ganarle a "credito": para eso existe el orden
    // por longitud, y el arreglo del empate no lo puede romper.
    expect(interpretarMensaje("necesito una nota de credito", W).via).toBe("sinonimo");
  });
});

// --- A6: un id que VUELVE es catálogo, no vidriera --------------------------

describe("A6 · los ids ocultos no mienten sobre el modo del server", () => {
  it.each([
    "menu:alta_cliente",
    "menu:alta_producto",
    "menu:cobro",
    "menu:productos",
    "menu:proveedores",
    "menu:pago_proveedor",
    "menu:datos_rut",
  ])('"%s" se reconoce en write_enabled', (id) => {
    // Le mandábamos el botón y, cuando lo tocaba, le decíamos que el server
    // estaba en modo consulta — estando en write_enabled.
    const r = interpretarMensaje(id, W);
    expect(r.via).toBe("id");
    expect(r.opcion?.id).toBe(id);
  });

  it("en read_only una intención de escritura SÍ dice que no está disponible", () => {
    const r = interpretarMensaje("menu:alta_cliente", R);
    expect(r.via).toBe("no_disponible");
    // El texto es para el USUARIO (el webhook lo manda tal cual), así que se
    // afirma lo que el usuario tiene que entender — no una frase interna.
    expect(r.respuesta_sugerida).toContain("solo de consulta");
    // Y lo que NO puede tener: nombres de variables ni órdenes al agente.
    expect(r.respuesta_sugerida).not.toContain("BILLER_");
    expect(r.respuesta_sugerida).not.toContain("Decile");
  });

  it("la NUMERACIÓN sigue contando solo lo que se muestra", () => {
    // La distinción vidriera/catálogo sigue valiendo para el número que escribe
    // el usuario: tiene que coincidir con la fila que ve.
    const r = interpretarMensaje("1", W);
    expect(r.via).toBe("numero");
    expect(r.opcion?.id).toBe("menu:emitir");
  });
});

// --- B3: "sí" y "pará" escritos --------------------------------------------

describe("B3 · se puede aceptar y frenar escribiendo, no solo tocando", () => {
  it.each(["si", "dale si", "confirmo", "asi esta bien"])(
    '"%s" es una afirmación y NO devuelve el menú',
    (mensaje) => {
      // `no` estaba en CORTESIAS desde el principio; `si` no estaba en ningún
      // lado. Se podía cancelar por texto pero no aceptar.
      const r = interpretarMensaje(mensaje, W);
      expect(r.via).toBe("afirmacion");
      expect(r.mostrar_menu).toBe(false);
    },
  );

  // "emitila" es las dos cosas según dónde caiga, y el contexto decide.
  //
  // Este caso vivía con los de arriba, en frío, y por eso el enrutador trataba
  // "emitila" como un "sí" SIEMPRE: el que arrancaba la conversación pidiendo
  // "emitila" recibía el acuse de una pregunta que nadie le había hecho. Que la
  // afirmación exija `en_flujo` es lo que dice el escenario B3 —aceptar lo que
  // está pendiente— y en frío la palabra vuelve a significar lo que significa.
  it.each(["emitila", "emitilo", "emiti"])('"%s" es afirmación SOLO dentro del flujo', (mensaje) => {
    const enFlujo = interpretarMensaje(mensaje, { ...W, en_flujo: true });
    expect(enFlujo.via).toBe("afirmacion");
    expect(enFlujo.mostrar_menu).toBe(false);
  });

  it.each(["emitila", "emitilo"])('"%s" en frío es un pedido de emitir', (mensaje) => {
    const enFrio = interpretarMensaje(mensaje, W);
    expect(enFrio.via).not.toBe("afirmacion");
    expect(enFrio.opcion?.id).toBe("menu:emitir");
  });

  it.each(["cancelalo", "para para", "no lo emitas", "mejor no", "frena"])(
    '"%s" es una cancelación y NO devuelve el menú',
    (mensaje) => {
      const r = interpretarMensaje(mensaje, W);
      expect(r.via).toBe("cancelacion");
      expect(r.mostrar_menu).toBe(false);
    },
  );

  it("la afirmación le avisa al agente que un 'sí' NO reemplaza al token", () => {
    // Es el único lugar donde un malentendido emite un CFE.
    expect(interpretarMensaje("si", W).respuesta_sugerida).toContain("confirmation_token");
  });
});

// --- B7: el número con una palabra al lado ----------------------------------

describe("B7 · elegir por número escribiendo alrededor", () => {
  it.each(["la 4", "opcion 3", "2 por favor", "el 2", "numero 5"])(
    '"%s" se lee como una elección',
    (mensaje) => {
      expect(interpretarMensaje(mensaje, W).via).toBe("numero");
    },
  );

  it("NO se traga cosas que solo contienen un número", () => {
    // "3 chapas" es un ítem que está cargando, no la opción 3.
    expect(interpretarMensaje("3 chapas", W).via).not.toBe("numero");
    expect(interpretarMensaje("anular la 456", W).via).not.toBe("numero");
  });
});

// --- B5: el flujo de emisión no se puede trancar ----------------------------

describe("B5 · un ítem vacío no tranca la emisión para siempre", () => {
  const base: EstadoEmision = {
    clase_receptor: "consumidor_final",
    sin_receptor: true,
    fecha_emision: "29/07/2026",
    moneda: "UYU",
    forma_pago: 1,
    montos_brutos: true,
    indicador_facturacion: 3,
    sin_adenda: true,
  };

  it("tocar ➕ por error y después ✅ cierra el comprobante", () => {
    // Antes: el chequeo de `concepto` iba antes que el de `items_cerrados`, así
    // que el ítem vacío pedía concepto para siempre — y ese paso es texto libre,
    // sin ningún botón de salida.
    const s = siguientePaso({
      ...base,
      items: [{ concepto: "Café", precio: 100, cantidad: 1 }, {}],
      items_cerrados: true,
    });
    expect(s.paso).toBe("confirmar");
    expect(s.listo).toBe(true);
  });

  it("con los ítems ABIERTOS, el vacío sigue pidiendo su concepto", () => {
    // El arreglo no puede tragarse el caso legítimo: si el usuario dijo que
    // agrega otro, hay que preguntarle qué es.
    const s = siguientePaso({
      ...base,
      items: [{ concepto: "Café", precio: 100, cantidad: 1 }, {}],
      items_cerrados: false,
    });
    expect(s.paso).toBe("concepto");
  });
});

// --- A9: la cantidad en letras no le puede ganar a los dígitos --------------

describe("A9 · los dígitos ganan siempre en una cantidad", () => {
  it.each([
    ["12 cajas de una unidad", 12],
    ["2 bolsas de un kilo", 2],
    ["una caja de 12", 12],
    ["3 bolsas para una obra", 3],
  ])('"%s" -> %i', (texto, esperado) => {
    // Facturar 1 en vez de 12 no se ve hasta que el CFE está emitido: el mismo
    // modo de falla que motivó el módulo, reproducido adentro del módulo.
    expect(parsearCantidad(texto).valor).toBe(esperado);
  });

  it.each([
    ["dos", 2],
    ["una docena", 12],
    ["media docena", 6],
    ["un par", 2],
  ])('las letras siguen valiendo solas: "%s" -> %s', (texto, esperado) => {
    expect(parsearCantidad(texto).valor).toBe(esperado);
  });

  it("un negativo no es una cantidad", () => {
    expect(parsearCantidad("-3").valor).toBeNull();
  });
});

// --- E1/E2: el resolvedor ---------------------------------------------------

describe("E1 · los conectores no pueden diluir la coincidencia", () => {
  const PRODUCTOS = [
    { nombre: "Bolsa de harina 000 x 25kg" },
    { nombre: "Bolsa de harina 0000 x 25kg" },
    { nombre: "Aceite de girasol 900ml" },
  ];

  it('"bolsa de harina" NO es un producto nuevo', () => {
    // Daba `ninguno` (0.23) y `comoSigue` contestaba "probablemente sea nuevo,
    // habrá que darlo de alta" — el duplicado que el módulo existe para evitar.
    const r = resolver("bolsa de harina", PRODUCTOS);
    expect(r.clase).toBe("ambiguo");
  });

  it('"la ferreteria" encuentra a "Ferretería López"', () => {
    const r = resolver("la ferreteria", [{ nombre: "Ferretería López" }, { nombre: "Juan Pérez" }]);
    expect(r.clase).toBe("unico");
  });
});

describe("E2 · un fragmento de dos letras no resuelve nada", () => {
  it('"ez" NO es "Juan Pérez"', () => {
    // Puntuaba 0.80 por contención y el resolvedor decía "es este, seguí con ese".
    const r = resolver("ez", [{ nombre: "Juan Pérez" }, { nombre: "Ferretería López" }]);
    expect(r.clase).toBe("ninguno");
  });

  it("con tres letras ya puede empezar a matchear", () => {
    expect(resolver("lop", [{ nombre: "Ferretería López" }]).clase).toBe("unico");
  });
});

// --- V4.2 #1 y #2: la gente no escribe como el catálogo ---------------------
//
// El informe de 155 mensajes marcaba 33 "sin salida" (21,3%) y decía que la
// tolerancia de edición recuperaba 14. La tolerancia ESTABA ESCRITA Y TESTEADA
// en `services/resolver.ts` desde antes; lo que faltaba era usarla en el
// enrutador. Al conectarla salieron a la luz los dos casos que la volvían
// urgente, y ninguno es un usuario escribiendo mal:
//
//   · el que DICTA un audio (WhatsApp transcribe fonético: "acele una fatura");
//   · el que usa el imperativo con clítico, que es el español rioplatense
//     normal ("facturale", "anulala") y que el catálogo solo tenía en infinitivo.

describe("V4.2 · transcripciones de audio llegan a destino", () => {
  it.each([
    ["acele una fatura a peres", "menu:emitir"],
    ["kien me deve plata", "menu:cobranzas"],
    ["komo biene el mes", "menu:mes"],
    ["kiero facturar", "menu:emitir"],
  ])('"%s" → %s', (mensaje, esperado) => {
    const r = interpretarMensaje(mensaje, W);
    expect(r.opcion?.id).toBe(esperado);
  });

  it("un match aproximado se declara como tal, con su confianza", () => {
    const r = interpretarMensaje("komo biene el mes", W);
    expect(r.via).toBe("aproximado");
    expect(r.confianza).toBeGreaterThan(0);
    expect(r.confianza).toBeLessThanOrEqual(1);
  });

  it("la tolerancia NO le gana a un match exacto", () => {
    // "anular" es exacto; que "anulala" exista no puede cambiar el resultado.
    const r = interpretarMensaje("anular", W);
    expect(r.via).toBe("sinonimo");
    expect(r.opcion?.id).toBe("menu:anular");
  });

  it("no une palabras que se parecen pero significan otra cosa", () => {
    // "comprar" vs "cobrar" están cerca en edición y son intenciones opuestas:
    // una es plata que entra y la otra plata que sale.
    const r = interpretarMensaje("cuanto compre", W);
    expect(r.opcion?.id).not.toBe("menu:cobranzas");
  });

  it("palabras cortas no se comparan por edición", () => {
    // Con 3 letras todo se parece a todo: "mes"/"mas"/"mis" están a una letra.
    const r = interpretarMensaje("mas", W);
    expect(r.opcion?.id).not.toBe("menu:mes");
  });
});

describe("V4.2 · imperativo con clítico", () => {
  it.each([
    ["facturale a perez 2 bolsas a 6500", "menu:emitir"],
    ["facturale a la panaderia", "menu:emitir"],
    ["emitile una factura", "menu:emitir"],
    ["anulala", "menu:anular"],
    ["anulalo por favor", "menu:anular"],
  ])('"%s" → %s', (mensaje, esperado) => {
    const r = interpretarMensaje(mensaje, W);
    expect(r.opcion?.id).toBe(esperado);
  });

  it("el ejemplo que emision.ts documenta como entrada real del flujo LLEGA", () => {
    // Cuatro pasos resueltos en un mensaje (cliente, cantidad, producto,
    // precio) que el enrutador tiraba enteros a "no entendí".
    const r = interpretarMensaje("facturale a perez 2 bolsas a 6500", W);
    expect(r.opcion?.id).toBe("menu:emitir");
    expect(r.mostrar_menu).toBe(false);
  });
});

// --- V4.2 #5: una pregunta de IVA no se contesta con lo facturado -----------

describe("V4.2 · el IVA tiene intención propia", () => {
  it.each([
    "cuanto tengo que pagar de IVA",
    "cuanto me da iva este mes",
    "el iva del mes",
    "posicion de iva",
  ])('"%s" NO se contesta con la facturación del mes', (mensaje) => {
    const r = interpretarMensaje(mensaje, W);
    expect(r.opcion?.id).toBe("menu:iva");
    // El error que esto arregla: devolver `menu:mes` —un número de plata— a una
    // pregunta de plata DISTINTA, con confianza y sin que nadie lo note.
    expect(r.opcion?.id).not.toBe("menu:mes");
  });

  it("apunta al catálogo, que es la tool que SIEMPRE está registrada", () => {
    // biller_posicion_iva es opt-in: apuntar ahí prometería una tool que en el
    // 99% de los despliegues no existe.
    const r = interpretarMensaje("cuanto tengo que pagar de IVA", W);
    expect(r.opcion?.tools).toContain("biller_catalogo_datos");
  });
});

// --- Un sinónimo EXACTO no puede empatarle a una inclusión ------------------

describe("exacto le gana a inclusión, aunque lo exacto esté bloqueado", () => {
  it('"me equivoqué con el recibo" en consulta NO abre el flujo de anular', () => {
    const r = interpretarMensaje("me equivoqué con el recibo", { capabilityMode: "read_only" });
    // El sinónimo exacto es de cancelar_recibo; "me equivoqué" entraba por
    // inclusión en anular y empataba. El desempate lo hacía el orden del
    // código, y ganaba anular: una NOTA DE CRÉDITO por un recibo.
    expect(r.opcion?.id).toBe("menu:cancelar_recibo");
    expect(r.opcion?.id).not.toBe("menu:anular");
    // En modo consulta no se puede hacer, y decirlo es la respuesta correcta.
    expect(r.via).toBe("no_disponible");
  });

  it("con escritura habilitada va a cancelar el recibo, no a anular", () => {
    const r = interpretarMensaje("me equivoqué con el recibo", { capabilityMode: "write_enabled" });
    expect(r.opcion?.id).toBe("menu:cancelar_recibo");
  });

  it("una inclusión sola sigue enrutando: el cambio no sube el listón", () => {
    const r = interpretarMensaje("necesito anular algo", { capabilityMode: "write_enabled" });
    expect(r.opcion?.id).toBe("menu:anular");
  });
});
