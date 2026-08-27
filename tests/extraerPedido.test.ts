// =============================================================================
// El extractor de pedidos: "facturale a Pérez 2 bolsas a 6.500" en TypeScript.
//
// LOS DOS LADOS QUE HAY QUE TESTEAR, Y EL SEGUNDO IMPORTA MÁS
//
// Lo que SÍ extrae se ve enseguida si falla: el flujo pregunta de más. Lo que
// NO tiene que extraer falla en silencio y caro — un falso positivo mete a
// alguien que preguntó "¿cuánto vendí en agosto?" en un flujo de emisión, o
// —peor— deja un cliente llamado "eran" en el borrador de un CFE. Por eso la
// mitad de este archivo son frases que NO son pedidos.
//
// Y una regla que atraviesa todo: NUNCA SE INVENTA. Un número que
// `parsearImporte` no puede leer no entra al pedido; queda afuera y el flujo lo
// pregunta, que es lo que haría una persona.
// =============================================================================

import { describe, expect, it } from "vitest";
import { esPedidoDeEmision, extraerPedidoEmision } from "../src/kapso/extraerPedido.js";

describe("la gramática mínima: [verbo]? (a|para) <cliente> + <cantidad> <concepto> a <precio>", () => {
  it("la forma canónica: los cuatro campos en un mensaje", () => {
    const p = extraerPedidoEmision("facturale a perez 2 bolsas de portland a 6500");
    expect(p.cliente).toBe("perez");
    expect(p.items[0]).toMatchObject({ concepto: "bolsas de portland", cantidad: 2, precio: 6500 });
    expect(esPedidoDeEmision(p)).toBe(true);
  });

  it("sin verbo conjugado y con comas: 'factura a perez, 2 bolsas..., 6500 cada una'", () => {
    // Las comas se vuelven espacio, salvo las que están ENTRE dígitos: ahí son
    // el separador decimal y comérselas parte un número en dos.
    const p = extraerPedidoEmision("factura a perez, 2 bolsas de portland, 6500 cada una");
    expect(p.cliente).toBe("perez");
    expect(p.items[0]).toMatchObject({ concepto: "bolsas de portland", cantidad: 2, precio: 6500 });
  });

  it("el cliente AL FINAL: '2 bolsas de portland a 6500 para perez'", () => {
    // El primer "a" va seguido de un número, así que no introduce al cliente.
    // El discriminador es mecánico y por eso funciona con nombres que no
    // conocemos: dígito después de la preposición o no.
    const p = extraerPedidoEmision("2 bolsas de portland a 6500 para perez");
    expect(p.cliente).toBe("perez");
    expect(p.items[0]).toMatchObject({ cantidad: 2, precio: 6500 });
  });

  it("telegráfico, sin ninguna preposición: 'perez 2 bolsas portland 6500'", () => {
    const p = extraerPedidoEmision("perez 2 bolsas portland 6500");
    expect(p.cliente).toBe("perez");
    expect(p.items[0]).toMatchObject({ concepto: "bolsas portland", cantidad: 2, precio: 6500 });
  });

  it("un monto sin ítems: 'una factura de 12000 a la panaderia'", () => {
    // Los artículos se saltean para llegar al nombre; el "de" antes del número
    // lo marca como importe.
    const p = extraerPedidoEmision("una factura de 12000 a la panaderia");
    expect(p.cliente).toBe("panaderia");
    expect(p.items[0]).toMatchObject({ precio: 12000 });
    expect(p.items[0]?.concepto).toBeUndefined();
  });

  it("sin precio: extracción PARCIAL, que es un éxito", () => {
    // Tres campos menos que preguntar; el precio se pregunta igual.
    const p = extraerPedidoEmision("ponele una factura a perez de 2 bolsas");
    expect(p.cliente).toBe("perez");
    expect(p.items[0]).toMatchObject({ concepto: "bolsas", cantidad: 2 });
    expect(p.items[0]?.precio).toBeUndefined();
    expect(esPedidoDeEmision(p)).toBe(true);
  });

  it("un solo campo, pero con el verbo adelante: 'sale factura para perez'", () => {
    const p = extraerPedidoEmision("sale factura para perez");
    expect(p.campos).toEqual(["cliente"]);
    expect(p.verbo).toBe(true);
    expect(esPedidoDeEmision(p)).toBe(true);
  });

  it('"cobrale" es emitir, no cobrar: el clítico es toda la diferencia', () => {
    // "cobrarle a alguien" en el mostrador es hacerle la factura. "cobrar" a
    // secas es la pregunta de la cobranza, y por eso no está en el vocabulario.
    const p = extraerPedidoEmision("cobrale 1500 a martinez");
    expect(p.verbo).toBe(true);
    expect(p.cliente).toBe("martinez");
    expect(p.items[0]?.precio).toBe(1500);
  });

  it("cantidad en letras, incluida la compuesta", () => {
    const p = extraerPedidoEmision("facturale a perez una docena de empanadas a 60 c/u");
    expect(p.items[0]).toMatchObject({ concepto: "empanadas", cantidad: 12, precio: 60 });
    // "de" abre el concepto pero no queda adentro: el ítem es de empanadas.
    expect(p.items[0]?.concepto).not.toContain("de ");
  });

  it("media docena son SEIS, no doce ni medio", () => {
    const p = extraerPedidoEmision("media docena de facturas a 40");
    expect(p.items[0]?.cantidad).toBe(6);
  });
});

// =============================================================================
// FISCAL-1: una venta con DOS ítems es una venta con dos ítems.
//
// La versión anterior tenía una sola `cantidad` y un solo `concepto`, así que
// "3 cajas a 1200 y 2 bolsas a 6500" facturaba $3.600 en vez de $16.600: la
// segunda mitad desaparecía sin un warning, y el CFE salía perfectamente bien
// formado. Un comprobante al que le falta media venta no lo nota nadie hasta
// que se cobra — y los 25 casos de arriba son todos de un ítem, así que la
// suite entera quedaba verde.
// =============================================================================

describe("varios ítems en un mensaje", () => {
  it('la frase del hallazgo: "3 cajas de clavos a 1200 y 2 bolsas de portland a 6500"', () => {
    const p = extraerPedidoEmision(
      "facturale a Gonzalez 3 cajas de clavos a 1200 y 2 bolsas de portland a 6500",
    );
    expect(p.cliente).toBe("gonzalez");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ concepto: "cajas de clavos", cantidad: 3, precio: 1200 });
    expect(p.items[1]).toMatchObject({ concepto: "bolsas de portland", cantidad: 2, precio: 6500 });

    // La cuenta que importa: 3×1200 + 2×6500 = 16.600, no 3.600.
    const total = p.items.reduce((a, i) => a + (i.cantidad ?? 1) * (i.precio ?? 0), 0);
    expect(total).toBe(16_600);
    expect(p.precios_sin_ubicar).toEqual([]);
  });

  it("la coma también separa, aunque el tokenizador se la coma", () => {
    // `tokenizarPedido` convierte la coma en espacio, así que el separador que
    // queda escrito es el número que se acaba de consumir como precio.
    const p = extraerPedidoEmision("3 cajas de clavos a 1200, 2 bolsas de portland a 6500");
    expect(p.items).toHaveLength(2);
    expect(p.items[1]).toMatchObject({ concepto: "bolsas de portland", cantidad: 2, precio: 6500 });
  });

  it("un salto de línea entre ítems se comporta igual que la coma", () => {
    const p = extraerPedidoEmision("facturale a perez\n2 bolsas a 6500\n3 cajas a 1200");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ cantidad: 2, precio: 6500 });
    expect(p.items[1]).toMatchObject({ cantidad: 3, precio: 1200 });
  });

  it("NO abre un ítem nuevo con la unidad de un producto", () => {
    // El error simétrico y peor, porque INVENTA una línea en vez de perderla:
    // "2 bolsas DE 25 KG a 300" no son dos ítems, es uno de 2 bolsas a $300.
    const p = extraerPedidoEmision("facturale a perez 2 bolsas de 25 kg a 300");
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ cantidad: 2, precio: 300 });
    expect(p.precios_sin_ubicar).toEqual([]);
  });

  it("un precio que no entra en ningún ítem NO se descarta en silencio", () => {
    // El freno obligatorio: el segundo tramo no trae cantidad, así que no hay
    // ítem donde poner los $6.500. Antes se perdían sin decir nada.
    const p = extraerPedidoEmision("facturale a perez 3 cajas de clavos a 1200 y portland a 6500");
    expect(p.items).toHaveLength(1);
    expect(p.precios_sin_ubicar).toEqual(["6500"]);
    expect(p.detalles.some((d) => d.includes("NO está completo"))).toBe(true);
  });

  it('el plazo de "a 30 días" no cuenta como precio perdido', () => {
    // Lleva la misma marca (la preposición es la misma) y no es plata. Sin la
    // exclusión, la frase más común del crédito abriría un "¿algo más?".
    const p = extraerPedidoEmision("facturale a perez 2 bolsas a 6500 a 30 dias");
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ cantidad: 2, precio: 6500 });
    expect(p.precios_sin_ubicar).toEqual([]);
    expect(p.forma_pago).toBe(2);
  });
});

// =============================================================================
// FISCAL-5: "500 de pan" son quinientos PESOS de pan.
//
// Leerlo como cantidad tenía dos consecuencias en cadena: 500 unidades, y
// después el precio confirmado ("500") multiplicado por esas 500 unidades —
// $250.000 por una bolsa de pan.
// =============================================================================

describe('la forma "N de X" es un importe, no una cantidad', () => {
  it.each([
    "facturale 500 de pan a la panaderia",
    "facturale 500 de pan",
    "500 de pan a la panaderia",
  ])('"%s" -> $500 de pan, no 500 panes', (texto) => {
    const p = extraerPedidoEmision(texto);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.concepto).toBe("pan");
    expect(p.items[0]?.precio).toBe(500);
    // Lo que NO puede pasar: que 500 quede de cantidad. Con la cantidad en 500,
    // confirmar el precio con "500" da $250.000.
    expect(p.items[0]?.cantidad).toBeUndefined();
  });

  it("con unidad adelante SÍ es cantidad: '2 bolsas de portland'", () => {
    // El contrapeso. La distinción es que el "de" venga pegado al número o no.
    const p = extraerPedidoEmision("facturale a perez 2 bolsas de portland a 6500");
    expect(p.items[0]).toMatchObject({ cantidad: 2, concepto: "bolsas de portland", precio: 6500 });
  });

  it("una cantidad en LETRAS con 'de' sigue siendo cantidad", () => {
    // "una docena de empanadas" son doce empanadas, no doce pesos de empanada.
    // El número escrito en letras es lo que separa los dos casos.
    const p = extraerPedidoEmision("facturale a perez una docena de empanadas a 60 c/u");
    expect(p.items[0]).toMatchObject({ cantidad: 12, concepto: "empanadas", precio: 60 });
  });

  it('"una factura de 12000" no se toca: ahí el "de" va ANTES del número', () => {
    const p = extraerPedidoEmision("una factura de 12000 a la panaderia");
    expect(p.items[0]?.precio).toBe(12_000);
    expect(p.items[0]?.concepto).toBeUndefined();
  });
});

describe("la plata la lee TypeScript, no el modelo", () => {
  it("el punto de miles: 6.500 son seis mil quinientos", () => {
    // `Number("6.500")` es 6.5. Es la línea que justifica el módulo entero.
    const p = extraerPedidoEmision("facturale a perez 2 bolsas a 6.500");
    expect(p.items[0]?.precio).toBe(6500);
    expect(p.ambiguo).toBe(false);
  });

  it("la AMBIGÜEDAD sobrevive hasta el preview", () => {
    // "6.50" puede ser 6,50 o 6.500: cien veces de diferencia. Se devuelve el
    // valor más probable MARCADO, para que se ecoe antes de emitir.
    const p = extraerPedidoEmision("facturale a perez 2 bolsas a 6.50");
    expect(p.items[0]?.precio).toBe(6.5);
    expect(p.items[0]?.precio_ambiguo).toBe(true);
    expect(p.ambiguo).toBe(true);
    expect(p.detalles.some((d) => d.startsWith("Precio:"))).toBe(true);
  });

  it("el símbolo pegado al número no rompe nada", () => {
    expect(extraerPedidoEmision("facturale a perez el flete a $2.500").items[0]?.precio).toBe(2500);
  });

  it("un número que no se puede leer NO se inventa", () => {
    // El precio queda afuera y el flujo lo pregunta. Devolver "lo más parecido"
    // es tapar el problema en el único momento en que todavía se puede resolver.
    const p = extraerPedidoEmision("facturale a perez 2 bolsas a mil quinientos");
    expect(p.items[0]?.precio).toBeUndefined();
    expect(p.cliente).toBe("perez");
  });
});

describe("las señales que no son números", () => {
  it.each([
    ["facturale a perez 2 bolsas a 100 con iva incluido", true],
    ["facturale a perez 2 bolsas a 100, iva aparte", false],
    ["emitile a rodriguez el flete, 2.500 mas iva", false],
  ])('"%s" -> montos_brutos %s', (texto, esperado) => {
    expect(extraerPedidoEmision(texto).montos_brutos).toBe(esperado);
  });

  it.each([
    ["facturale a gonzalez 5 cajas a 100 dolares", "USD"],
    ["cobrale 200 pesos a perez", "UYU"],
  ])('"%s" -> moneda %s', (texto, esperado) => {
    expect(extraerPedidoEmision(texto).moneda).toBe(esperado);
  });

  it.each([
    ["hacele una factura a la panaderia a credito", 2],
    ["facturale a perez 2 bolsas a 100 al contado", 1],
  ])('"%s" -> forma_pago %s', (texto, esperado) => {
    expect(extraerPedidoEmision(texto).forma_pago).toBe(esperado);
  });

  it('"a credito" NO es un cliente llamado credito', () => {
    // La preposición que introduce la forma de pago es la misma que introduce
    // al cliente. Sin el vocabulario de exclusión, el CFE salía a nombre de
    // "credito" — un cliente inventado, que es el error más caro de una emisión.
    expect(extraerPedidoEmision("hacele una factura a la panaderia a credito").cliente).toBe(
      "panaderia",
    );
  });
});

describe("lo que NO es un pedido de emisión", () => {
  it.each([
    // Preguntas sobre números: la mitad del tráfico del canal.
    "cuanto vendi en agosto",
    "quien me debe plata",
    "como viene el mes",
    "que productos vendo mas",
    // Un número que es un NÚMERO DE COMPROBANTE, no un precio.
    "me pagaron la factura 1234",
    "me pagaron la 1234",
    "anular la 456",
    // Frases con un nombre o un artículo adentro que no piden nada.
    "mi tio compro una bicicleta",
    "che y las retenciones del año pasado",
    "mostrame las ultimas facturas",
    // Correcciones en medio de una carga: las contesta el flujo, no el menú.
    "para, eran 3 no 2",
    "el rut es 210475730011",
    "que sean de 25kg",
    // Y lo que no es nada.
    "hola",
    "gracias",
    "",
    "   ",
    "🙂",
  ])('"%s" NO se enruta como pedido', (texto) => {
    expect(esPedidoDeEmision(extraerPedidoEmision(texto))).toBe(false);
  });

  it("un número de comprobante no se lee como precio", () => {
    // Sin la exigencia de una marca o de una venta declarada, "me pagaron la
    // factura 1234" cargaba $1.234 en un ítem.
    const p = extraerPedidoEmision("me pagaron la factura 1234");
    expect(p.items).toEqual([]);
  });

  it('"pará, eran 3 no 2" no deja un cliente llamado "eran"', () => {
    // Es la corrección más común del mostrador y llega en medio de una carga.
    // Un nombre sacado de acá se copiaría al borrador de un comprobante fiscal.
    const p = extraerPedidoEmision("para, eran 3 no 2");
    expect(p.cliente).toBeUndefined();
    expect(p.campos).toEqual([]);
  });

  it("una pregunta con verbo de facturar adentro tampoco alcanza", () => {
    // "factura" es el sustantivo más frecuente del canal: el verbo solo no
    // puede enrutar nada, hace falta al menos un campo.
    const p = extraerPedidoEmision("cuanto facture este mes");
    expect(p.verbo).toBe(true);
    expect(p.campos).toEqual([]);
    expect(esPedidoDeEmision(p)).toBe(false);
  });
});

describe("el módulo es puro y no se cae con nada", () => {
  it.each([
    "",
    "   ",
    "$$$",
    "a a a a a",
    "1 2 3 4 5 6 7 8 9",
    "facturale a",
    "a perez",
    "🙂🙂🙂",
    "AAAA".repeat(200),
  ])('"%s" no tira', (texto) => {
    expect(() => extraerPedidoEmision(texto)).not.toThrow();
  });

  it("dos llamadas con el mismo texto dan el mismo resultado", () => {
    const frase = "facturale a perez 2 bolsas de portland a 6.500 con iva incluido";
    expect(extraerPedidoEmision(frase)).toEqual(extraerPedidoEmision(frase));
  });
});
