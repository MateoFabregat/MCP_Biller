// =============================================================================
// El resolvedor de nombres.
//
// Estos tests son un CORPUS antes que una suite: la mayoría son pares
// (lo que escribió el usuario, lo que quiso decir) que salen de cómo se escriben
// los nombres de verdad — sin tildes, sin el "S.R.L.", con el apellido con s en
// vez de z, y a veces con la palabra genérica adelante y nada más.
//
// La regla que más cuesta sostener y la que más importa: cuando hay dos
// candidatos parecidos NO se elige. Varios de estos tests existen para que
// alguien que quiera "mejorar la precisión" bajando el margen vea qué rompe.
// =============================================================================

import { describe, expect, it } from "vitest";
import { interpretarMensaje, interpretarRespuestaResolucion } from "../src/kapso/menu.js";
import {
  MARGEN_DECISIVO,
  UMBRAL_MINIMO,
  distanciaEdicion,
  normalizarNombre,
  resolver,
  similitudNombres,
} from "../src/services/resolver.js";

const CLIENTES = [
  { nombre: "Distribuidora Pérez S.R.L.", documento: "218765430011" },
  { nombre: "Peres Hnos", documento: "212345670013" },
  { nombre: "Almacén La Estrella", documento: "211111110019" },
  { nombre: "Supermercado Norte SA", documento: "213333330015" },
  { nombre: "Distribuidora Sur S.A.", documento: "214444440011" },
];

/** Atajo: nombre resuelto, o la clase cuando no hay uno solo. */
function resolvido(consulta: string, universo = CLIENTES): string {
  const r = resolver(consulta, universo);
  return r.clase === "unico" ? r.elegido.item.nombre : r.clase;
}

// --- Normalización ----------------------------------------------------------

describe("normalizarNombre", () => {
  it("saca tildes: una tilde de menos no es un error de tipeo", () => {
    expect(normalizarNombre("Pérez")).toBe(normalizarNombre("Perez"));
  });

  it("saca el sufijo societario escrito de las tres formas que se usa", () => {
    expect(normalizarNombre("Pérez S.R.L.")).toBe("perez");
    expect(normalizarNombre("Perez SRL")).toBe("perez");
    expect(normalizarNombre("Perez S R L")).toBe("perez");
  });

  it("reúne las iniciales sueltas que dejó la puntuación", () => {
    // "S.A." -> "s a" -> "sa" -> sufijo -> fuera. Sin esto, dos tokens de basura
    // hacen que cualquier nombre de dos palabras gane por cobertura.
    expect(normalizarNombre("Distribuidora Sur S.A.")).toBe("distribuidora sur");
  });

  it("un nombre que ES el sufijo no se vuelve la cadena vacía", () => {
    // Una cadena vacía matchearía con absolutamente todo.
    expect(normalizarNombre("SA")).not.toBe("");
  });
});

describe("distanciaEdicion", () => {
  it.each([
    ["perez", "peres", 1],
    ["harina", "harnia", 2],
    ["", "abc", 3],
    ["igual", "igual", 0],
  ])("%s -> %s = %i", (a, b, esperado) => {
    expect(distanciaEdicion(a, b)).toBe(esperado);
  });
});

// --- El caso que motivó todo ------------------------------------------------

describe("el typo en el nombre del cliente", () => {
  it('"Distribuidora Peres" es "Distribuidora Pérez S.R.L."', () => {
    expect(resolvido("Distribuidora Peres")).toBe("Distribuidora Pérez S.R.L.");
  });

  it("NO le gana un cliente que solo comparte la primera palabra", () => {
    // Este es el bug que tuvo el resolvedor en su primera versión: la distancia
    // de edición sobre la cadena entera premiaba las trece letras iguales de
    // "Distribuidora" y "Distribuidora Sur SA" le ganaba al Pérez correcto.
    const r = resolver("Distribuidora Peres", CLIENTES);
    expect(r.clase).toBe("unico");
    if (r.clase !== "unico") return;
    expect(r.elegido.item.nombre).not.toBe("Distribuidora Sur S.A.");
  });

  it.each([
    ["Distribuidora Pérez SRL", "Distribuidora Pérez S.R.L."],
    ["distribuidora perez", "Distribuidora Pérez S.R.L."],
    ["almacen la estrela", "Almacén La Estrella"],
    ["la estrella", "Almacén La Estrella"],
    ["estrella", "Almacén La Estrella"],
    ["Supermercado Norte", "Supermercado Norte SA"],
    ["norte", "Supermercado Norte SA"],
  ])("%s -> %s", (consulta, esperado) => {
    expect(resolvido(consulta)).toBe(esperado);
  });
});

// --- La regla central: ante la duda, se pregunta ----------------------------

describe("no elige cuando no está claro", () => {
  it('"distribuidora" es ambiguo: hay dos y la palabra no distingue', () => {
    const r = resolver("distribuidora", CLIENTES);
    expect(r.clase).toBe("ambiguo");
    if (r.clase !== "ambiguo") return;
    expect(r.candidatos.map((c) => c.item.nombre).sort()).toEqual([
      "Distribuidora Pérez S.R.L.",
      "Distribuidora Sur S.A.",
    ]);
  });

  it("devuelve como mucho 3 candidatos: es lo que entra en botones de WhatsApp", () => {
    const muchos = Array.from({ length: 8 }, (_, i) => ({
      nombre: `Panadería Central ${i}`,
      documento: `21000000001${i}`,
    }));
    const r = resolver("Panaderia Central", muchos);
    if (r.clase !== "ambiguo") throw new Error(`esperaba ambiguo, fue ${r.clase}`);
    expect(r.candidatos.length).toBe(3);
  });

  it("dos entradas con el MISMO documento se preguntan (cliente cargado dos veces)", () => {
    const duplicado = [
      { nombre: "Pérez S.R.L.", documento: "218765430011" },
      { nombre: "Distribuidora Perez", documento: "218765430011" },
    ];
    const r = resolver("218765430011", duplicado);
    expect(r.clase).toBe("ambiguo");
  });

  it("el margen decisivo no es cero: bajarlo a 0 rompe la desambiguación", () => {
    // Test de intención, no de implementación: si alguien pone MARGEN_DECISIVO
    // en 0 "para que siempre elija", este falla y le dice por qué está mal.
    expect(MARGEN_DECISIVO).toBeGreaterThan(0);
    expect(UMBRAL_MINIMO).toBeGreaterThan(0.5);
  });
});

// --- Ninguno: es una respuesta, no un fracaso -------------------------------

describe("cuando no hay nada parecido", () => {
  it("no inventa: un nombre que no existe da 'ninguno'", () => {
    const r = resolver("Panadería Rivera", CLIENTES);
    expect(r.clase).toBe("ninguno");
  });

  it("un universo vacío da 'ninguno', no una excepción", () => {
    expect(resolver("cualquier cosa", []).clase).toBe("ninguno");
  });

  it("texto vacío da 'ninguno'", () => {
    expect(resolver("   ", CLIENTES).clase).toBe("ninguno");
  });
});

// --- Documento: certeza, no parecido ---------------------------------------

describe("resolver por RUT o cédula", () => {
  it("un documento que coincide gana sin mirar el nombre", () => {
    const r = resolver("218765430011", CLIENTES);
    expect(r.clase).toBe("unico");
    if (r.clase !== "unico") return;
    expect(r.elegido.via).toBe("documento");
    expect(r.elegido.score).toBe(1);
  });

  it("acepta el documento con puntos y guiones, como lo escribe la gente", () => {
    const r = resolver("218765430-011", CLIENTES);
    expect(r.clase).toBe("unico");
  });

  it("un documento que no está no cae en un parecido por nombre", () => {
    expect(resolver("219999999999", CLIENTES).clase).toBe("ninguno");
  });
});

// --- Productos --------------------------------------------------------------

describe("productos", () => {
  const PRODUCTOS = [
    { nombre: "Bolsa de harina 000 25kg", documento: "HAR-25" },
    { nombre: "Bolsa de azúcar 1kg", documento: "AZU-01" },
    { nombre: "Aceite de girasol 900ml", documento: "ACE-900" },
  ];

  it.each([
    ["bolsa de harnia 000 25kg", "Bolsa de harina 000 25kg"],
    ["harina 000", "Bolsa de harina 000 25kg"],
    ["aceite girasol", "Aceite de girasol 900ml"],
    ["HAR-25", "Bolsa de harina 000 25kg"],
  ])("%s -> %s", (consulta, esperado) => {
    expect(resolvido(consulta, PRODUCTOS)).toBe(esperado);
  });

  it('"bolsa" solo es ambiguo: hay dos bolsas', () => {
    expect(resolver("bolsa", PRODUCTOS).clase).toBe("ambiguo");
  });
});

// --- El enrutador reconoce la respuesta ------------------------------------

describe("los botones de desambiguación vuelven por el enrutador", () => {
  it("'resolver:cliente:1' se lee como la elección, no como texto libre", () => {
    const r = interpretarMensaje("resolver:cliente:1");
    expect(r.via).toBe("resolucion_elegida");
    expect(r.resolucion).toEqual({ tipo: "cliente", indice: 1 });
    // Lo importante: NO devuelve el menú. Mandar el menú acá tira a la basura la
    // pregunta que el usuario acaba de contestar.
    expect(r.mostrar_menu).toBe(false);
  });

  it("'resolver:producto:0' también", () => {
    expect(interpretarRespuestaResolucion("resolver:producto:0")).toEqual({
      tipo: "producto",
      indice: 0,
    });
  });

  it("un id mal formado no se reconoce y sigue su camino", () => {
    expect(interpretarRespuestaResolucion("resolver:otracosa:1")).toBeNull();
    expect(interpretarRespuestaResolucion("resolver:cliente:x")).toBeNull();
    expect(interpretarRespuestaResolucion("hola")).toBeNull();
  });

  it("el prefijo se resuelve ANTES que la heurística por palabras", () => {
    // "resolver:cliente:0" contiene "cliente", que es palabra de otra intención.
    // Es el mismo bug que tuvo "emitir:no" con la opción de emitir.
    const r = interpretarMensaje("resolver:cliente:0");
    expect(r.opcion).toBeNull();
  });
});

// --- Propiedades de la similitud -------------------------------------------

describe("similitudNombres", () => {
  it("es 1 para el mismo nombre escrito distinto", () => {
    expect(similitudNombres("Pérez S.R.L.", "perez srl")).toBe(1);
  });

  it("es simétrica", () => {
    expect(similitudNombres("Distribuidora Perez", "Distribuidora Pérez S.R.L.")).toBeCloseTo(
      similitudNombres("Distribuidora Pérez S.R.L.", "Distribuidora Perez"),
      5,
    );
  });

  it("nombres sin relación quedan por debajo del umbral", () => {
    expect(similitudNombres("Panadería Rivera", "Supermercado Norte")).toBeLessThan(UMBRAL_MINIMO);
  });
});
