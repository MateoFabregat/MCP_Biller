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
  formatearPrecioAviso,
  normalizarItems,
  rellenarDesdePedido,
} from "../src/kapso/borradorEmision.js";
import { extraerPedidoEmision } from "../src/kapso/extraerPedido.js";
import { itemSinNada, type EstadoEmision } from "../src/kapso/emision.js";

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
  it("aplica sobre el ÍTEM EN CURSO, que es el mismo que elige siguientePaso", () => {
    // Los dos están a medio cargar (les falta el precio): el flujo pregunta por
    // el PRIMERO, así que la respuesta es de ese. Aplicarla al último —la
    // convención vieja— le pone la cantidad a una línea que el usuario no está
    // contestando, y eso en un CFE es un total equivocado.
    const aMedias: EstadoEmision = { items: [{ concepto: "Café" }, { concepto: "Té" }] };
    aplicarAlItemEnCurso(aMedias, (i) => (i.cantidad = 3));
    expect(aMedias.items?.[0]?.cantidad).toBe(3);
    expect(aMedias.items?.[1]?.cantidad).toBeUndefined();

    // Con todo completo, el ítem en curso es el último: es el que se acaba de
    // cargar y sobre el que se está hablando.
    const completos: EstadoEmision = {
      items: [
        { concepto: "Café", precio: 100 },
        { concepto: "Té", precio: 120 },
      ],
    };
    aplicarAlItemEnCurso(completos, (i) => (i.cantidad = 2));
    expect(completos.items?.[0]?.cantidad).toBeUndefined();
    expect(completos.items?.[1]?.cantidad).toBe(2);
  });

  it("no se lleva puesta una cantidad que el usuario tipeó", () => {
    // `itemSinNada` decide qué puede descartar "↩️ Volver así". Miraba concepto
    // y precio y no la cantidad, así que `[{A,100},{cantidad:2},{C,300}]` volvía
    // sin el "2" que alguien había tipeado. Barato no es lo mismo que nada.
    expect(itemSinNada({})).toBe(true);
    expect(itemSinNada({ cantidad: 2 })).toBe(false);
    expect(itemSinNada({ precio: 250 })).toBe(false);
    expect(itemSinNada({ concepto: "Café" })).toBe(false);
  });

  it("se mide sobre los ítems VIGENTES, no sobre el array crudo", () => {
    // Cerrados los ítems, la cola sin nada no se pregunta — así que tampoco
    // puede recibir la respuesta. Antes el flujo preguntaba por A y la cantidad
    // aterrizaba en el fantasma del final.
    const estado: EstadoEmision = {
      items_cerrados: true,
      items: [{ concepto: "Café", precio: 0 }, {}],
    };
    aplicarAlItemEnCurso(estado, (i) => (i.cantidad = 7));
    expect(estado.items?.[0]?.cantidad).toBe(7);
    expect(estado.items?.[1]).toEqual({});
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

  it("la respuesta de texto cae en el ítem EN CURSO, no en el primero", () => {
    // El índice de `pedido.items` es el del MENSAJE recién parseado, no el del
    // comprobante. Volcándolo desde 0, con `[{Café,1200},{precio:250}]` y el
    // usuario contestando "eran 2 medialunas", el 2 aterrizaba como cantidad
    // del CAFÉ —que pasaba a $2.400—, las medialunas no se cargaban nunca y la
    // pregunta se repetía para siempre. Como esto solo llena huecos, no fallaba
    // por ningún lado: ni 422, ni warning.
    const estado: EstadoEmision = {
      items: [{ concepto: "Café", cantidad: 1, precio: 1200 }, { precio: 250 }],
    };
    const { puestos } = rellenarDesdePedido(estado, extraerPedidoEmision("eran 2 medialunas")!);
    expect(estado.items?.[0]).toEqual({ concepto: "Café", cantidad: 1, precio: 1200 });
    expect(estado.items?.[1]).toMatchObject({ concepto: "medialunas", cantidad: 2, precio: 250 });
    expect(puestos.join(" ")).toContain("items[1]");
    // Y NO deja un cliente llamado "eran": la etapa del cliente quedó atrás
    // cuando ya hay una línea cargada.
    expect(estado.nombre_cliente).toBeUndefined();
  });

  it("no le pone a una línea el precio de OTRA línea", () => {
    // `[{Café, sin precio}, {tortas,3,450}]`: el ítem en curso es el café (es al
    // que le falta el precio) y el texto habla de las tortas. Llenar el hueco
    // le ponía al café los $450 de la otra línea, y el flujo decía "listo".
    const estado: EstadoEmision = {
      items: [
        { concepto: "Café", cantidad: 1 },
        { concepto: "tortas", cantidad: 3, precio: 450 },
      ],
    };
    const { puestos, avisos } = rellenarDesdePedido(
      estado,
      extraerPedidoEmision("sumale 3 tortas a 450")!,
    );
    expect(estado.items?.[0]).toEqual({ concepto: "Café", cantidad: 1 });
    expect(avisos.join(" ")).toContain("otra línea");
    // Y los $450 de esa línea no se evaporan: abren un ítem para preguntarlos,
    // porque el aviso dura un turno y el borrador dura la conversación.
    expect(puestos.join(" ")).toContain("precio sin ubicar");
    expect(estado.items?.[estado.items.length - 1]).toEqual({});
    expect(avisos.join(" ")).toContain("450");
  });

  it("dos productos de la misma familia NO son la misma línea", () => {
    // "agua" alcanzaba para declarar que "Agua tónica" y "agua mineral" eran la
    // misma línea: el CFE imprimía "3 × Agua tónica $60" y la mineral no
    // existía nunca. En un almacén uruguayo el patrón es la norma —agua
    // mineral/tónica, coca común/zero, queso magro/colonia—: la palabra
    // compartida es la categoría, y la que las distingue es la que importa.
    const estado: EstadoEmision = { items: [{ concepto: "Agua tonica", cantidad: 1 }] };
    const { puestos, avisos } = rellenarDesdePedido(
      estado,
      extraerPedidoEmision("3 agua mineral a 60")!,
    );
    expect(estado.items?.[0]).toEqual({ concepto: "Agua tonica", cantidad: 1 });
    expect(puestos.join(" ")).not.toContain("items[0].precio");
    expect(avisos.join(" ")).toContain("otra línea");
    // Y los $60 abren un ítem para preguntarlos, en vez de evaporarse.
    expect(estado.items?.[estado.items.length - 1]).toEqual({});
  });

  it("un e-Ticket SIN receptor no se lleva una razón social del texto del ítem", () => {
    // La guarda vieja miraba "¿hay líneas cargadas?" y no cubría la PRIMERA
    // pregunta de ítem: "coca 2 litros" dejaba `nombre_cliente: "coca"` en un
    // comprobante que el usuario había pedido sin identificar, y `completar` le
    // ordenaba al agente ponerlo en `cliente.razon_social`.
    for (const mensaje of ["coca 2 litros", "agua mineral 6 a 45"]) {
      const estado: EstadoEmision = {
        clase_receptor: "consumidor_final",
        sin_receptor: true,
        montos_brutos: true,
        indicador_facturacion: 3,
      };
      rellenarDesdePedido(estado, extraerPedidoEmision(mensaje)!);
      expect(estado.nombre_cliente, mensaje).toBeUndefined();
      const { completar } = borradorComprobante(estado, 101);
      expect(completar.join(" "), mensaje).not.toContain("razon_social");
    }
  });

  it("pero el mismo concepto dicho de otra forma SÍ llena el hueco", () => {
    // "Bolsa de portland" y "bolsas de portland" son la misma línea escrita dos
    // veces: el agente escribe una y el usuario la otra. Frenar acá le haría
    // repetir un dato que ya dijo.
    const estado: EstadoEmision = { items: [{ concepto: "Bolsa de portland", cantidad: 3 }] };
    rellenarDesdePedido(estado, extraerPedidoEmision("facturale a perez 2 bolsas de portland a 6.500")!);
    expect(estado.items?.[0]?.precio).toBe(6500);
  });

  it("el eco de una línea ya cargada no se vuelca ni se duplica, y se dice", () => {
    // "sumale 3 tortas a 450" con las tortas YA en `items`: volcarlo sobre el
    // primer ítem le corría los datos (el 3 se pegaba al café: $4.950 en vez de
    // $2.550) y agregarlo como línea nueva las cobraba dos veces.
    const estado: EstadoEmision = {
      items: [
        { concepto: "Café", cantidad: 1, precio: 1200 },
        { concepto: "tortas", cantidad: 3, precio: 450 },
      ],
    };
    const { puestos, avisos } = rellenarDesdePedido(
      estado,
      extraerPedidoEmision("sumale 3 tortas a 450")!,
    );
    expect(estado.items).toEqual([
      { concepto: "Café", cantidad: 1, precio: 1200 },
      { concepto: "tortas", cantidad: 3, precio: 450 },
    ]);
    expect(puestos).toEqual([]);
    expect(estado.nombre_cliente).toBeUndefined();
    // Que no se vuelque no puede ser silencioso: un dato leído y descartado sin
    // decirlo es indistinguible de uno que no se leyó.
    expect(avisos.join(" ")).toContain("no se volcó");
  });

  it("un precio que no entró en ninguna línea abre un ítem vacío", () => {
    const estado: EstadoEmision = {};
    const { puestos } = rellenarDesdePedido(
      estado,
      extraerPedidoEmision("facturale a gonzalez 3 cajas de clavos a 1200 y portland a 6500")!,
    );
    expect(estado.items?.[estado.items.length - 1]).toEqual({});
    expect(puestos.join(" ")).toContain("precio sin ubicar");
  });

  it("formatea los precios huérfanos con la moneda efectiva y el formato uruguayo", () => {
    expect(formatearPrecioAviso(6500)).toBe("$6.500");
    expect(formatearPrecioAviso(12.5)).toBe("$12,50");
    expect(formatearPrecioAviso(0)).toBe("$0");
    // El signo va ANTES del símbolo. Antes salía "U$S-1.200", que es la misma
    // convención que `calcularTotales` prohíbe y testea (`not.toContain("$-")`):
    // el guión pegado al símbolo se lee como parte del número.
    expect(formatearPrecioAviso(-1200, "USD")).toBe("−U$S1.200");
    expect(formatearPrecioAviso(-1200, "USD")).not.toContain("$-");

    const estado: EstadoEmision = {
      moneda: "USD",
      items: [
        { concepto: "Café", cantidad: 1 },
        { concepto: "tortas", cantidad: 3, precio: 450 },
      ],
    };
    const { avisos } = rellenarDesdePedido(estado, extraerPedidoEmision("sumale 3 tortas a 450")!);
    expect(avisos.join(" ")).toContain("U$S450");
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

  // --- El filtro silencioso, que dejó de serlo ------------------------------
  //
  // El filtro de arriba es correcto y no alcanza: filtrando el ítem DEL MEDIO
  // se rompe la correspondencia por posición entre el borrador y el estado
  // guardado, que es de lo único que dispone tanto el agente (a quien
  // `completar` le pide los conceptos en orden) como `completarDesdeSesion` en
  // `write/emitirComprobante.ts` (que rellena `items[i].concepto` desde
  // `itemsGuardados[i]`). Con `[{A,100},{B sin precio},{C,300}]` la línea de
  // $300 salía con el concepto de B.
  it("con un agujero en el medio el borrador CORTA ahí, en vez de correr los conceptos", () => {
    const { borrador, completar, incompletos } = borradorComprobante(
      {
        ...BASE,
        items: [
          { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
          { concepto: "Portland", cantidad: 1 },
          { concepto: "Arena", cantidad: 1, precio: 300 },
        ],
      },
      111,
    );
    // Solo el prefijo alineado. La línea de $300 NO puede viajar en la posición
    // 1, que es la del ítem cuyo concepto es "Portland".
    expect(borrador["items"]).toEqual([
      { cantidad: 2, precio: 100, indicador_facturacion: 3 },
    ]);
    expect(incompletos).toEqual([{ posicion: 2, falta: ["precio"] }]);
    // Y el filtro deja de ser silencioso: lo dice donde el agente lo lee.
    expect(completar.join(" ")).toContain("ítem 2");
    expect(completar.join(" ")).toContain("precio");
  });

  it("una bonificación a $0 y un descuento negativo SÍ viajan: no son agujeros", () => {
    // H2 de la revisión fiscal. "Qué falta preguntar" y "qué línea no puede
    // viajar" son dos preguntas distintas: `siguientePaso` considera incompleto
    // un precio que no sea positivo (razonable para preguntar), pero
    // `ItemSchema` no restringe el signo y una bonificación a $0 o un descuento
    // negativo son líneas emitibles. Con el criterio de preguntar aplicado acá,
    // el borrador cortaba en la línea bonificada y se emitía de menos.
    const cero = borradorComprobante(
      {
        ...BASE,
        items: [
          { concepto: "Servicio", cantidad: 1, precio: 1000 },
          { concepto: "Bonificación", cantidad: 1, precio: 0 },
          { concepto: "Flete", cantidad: 1, precio: 300 },
        ],
      },
      111,
    );
    expect(cero.borrador["items"]).toHaveLength(3);
    expect(cero.incompletos).toEqual([]);

    const negativo = borradorComprobante(
      {
        ...BASE,
        items: [
          { concepto: "Servicio", cantidad: 1, precio: 1000 },
          { concepto: "Descuento", cantidad: 1, precio: -200 },
          { concepto: "Flete", cantidad: 1, precio: 300 },
        ],
      },
      111,
    );
    expect(negativo.borrador["items"]).toHaveLength(3);
    expect(negativo.incompletos).toEqual([]);
  });

  it("sin agujeros no dice nada nuevo y manda todas las líneas", () => {
    const { borrador, incompletos } = borradorComprobante(
      {
        ...BASE,
        items: [
          { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
          { concepto: "Arena", cantidad: 1, precio: 300 },
        ],
      },
      111,
    );
    expect(borrador["items"]).toHaveLength(2);
    expect(incompletos).toEqual([]);
  });

  it("el agujero AL FINAL no corta nada: las líneas de antes siguen alineadas", () => {
    // Es el caso que ya andaba —el ítem recién abierto con ➕— y tiene que
    // seguir andando igual: cortar en el último no saca ninguna línea.
    const { borrador, incompletos } = borradorComprobante(
      {
        ...BASE,
        items: [
          { concepto: "Bolsa de harina", cantidad: 2, precio: 100 },
          { concepto: "Arena", cantidad: 1, precio: 300 },
          {},
        ],
      },
      111,
    );
    expect(borrador["items"]).toHaveLength(2);
    expect(incompletos).toEqual([{ posicion: 3, falta: ["concepto", "precio"] }]);
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
