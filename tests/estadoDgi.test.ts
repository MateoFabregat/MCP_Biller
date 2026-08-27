// =============================================================================
// El criterio de estado DGI: uno solo, para todos los totales.
//
// Este archivo fija tres cosas que se rompieron una vez y no se pueden volver a
// romper en silencio:
//
//   1. Qué clase le corresponde a cada estado observado (y a los que no
//      conocemos).
//   2. Que exista UNA sola `clasificarEstado` en `src/`. Hasta agosto de 2026
//      había dos con semánticas distintas —el resumen contaba el estado
//      desconocido y los rankings lo excluían—, así que las mismas facturas
//      daban dos totales y cambiar un import por el otro los movía sin que tsc
//      dijera nada.
//   3. Que la exclusión por estado se AVISE. El criterio estricto (solo
//      "Aceptado DGI") es defendible porque es el que usa Biller, pero deja
//      afuera comprobantes cuyo estado puede faltar por un problema de la API y
//      no del comprobante: sin el aviso, el usuario ve un total bajo y no tiene
//      forma de saber por qué.
// =============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeComprobantesEmitidos } from "../src/biller/normalize.js";
import { detectarRechazos } from "../src/services/alertas.js";
import { calcularCohortes } from "../src/services/cohortes.js";
import { compararPeriodos } from "../src/services/comparacion.js";
import { clasificarEstado, esVentaValida, estaAceptado } from "../src/services/estadoDgi.js";
import { calcularPosicionIva } from "../src/services/posicionIva.js";
import { rankingClientes } from "../src/services/rankingClientes.js";
import { rankingProductos } from "../src/services/rankingProductos.js";
import { resumirFacturacion } from "../src/services/resumenFacturacion.js";
import { rankingSucursales } from "../src/services/sucursales.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

describe("clasificarEstado", () => {
  it("clasifica cada estado observado en la API", () => {
    expect(clasificarEstado("Aceptado DGI")).toBe("aceptado");
    expect(clasificarEstado("Rechazado DGI")).toBe("rechazado");
    expect(clasificarEstado("Sobre Rechazado DGI")).toBe("rechazado");
    expect(clasificarEstado("Pendiente DGI")).toBe("pendiente");
    expect(clasificarEstado("Envío no corresponde")).toBe("no_corresponde_enviar");
    // Sin tildes y con otra caja: la API devuelve el texto tal cual y no hay
    // garantía de que no cambie el acento.
    expect(clasificarEstado("envio no corresponde")).toBe("no_corresponde_enviar");
  });

  it("trata como desconocido el estado ausente, vacío o irreconocible", () => {
    expect(clasificarEstado(null)).toBe("desconocido");
    expect(clasificarEstado(undefined)).toBe("desconocido");
    expect(clasificarEstado("")).toBe("desconocido");
    expect(clasificarEstado("   ")).toBe("desconocido");
    expect(clasificarEstado("Estado Inventado XYZ")).toBe("desconocido");
  });
});

describe("estaAceptado (el criterio de todo total de plata)", () => {
  // Una fila por clase de estado: es la tabla que decide si el número del
  // asistente coincide con el del panel de Biller.
  it("solo cuenta 'Aceptado DGI'", () => {
    expect(estaAceptado("Aceptado DGI")).toBe(true);
    expect(estaAceptado("Rechazado DGI")).toBe(false);
    expect(estaAceptado("Sobre Rechazado DGI")).toBe(false);
    expect(estaAceptado("Pendiente DGI")).toBe(false);
    expect(estaAceptado("Envío no corresponde")).toBe(false);
    expect(estaAceptado(null)).toBe(false);
    expect(estaAceptado("")).toBe(false);
    expect(estaAceptado("Estado Inventado XYZ")).toBe(false);
  });

  // H7: la implementación vieja comparaba por substring (`/aceptado/i`), esta
  // compara exacto. Para los cinco estados observados da lo mismo; difiere solo
  // con una variante que la API nunca devolvió. El test PINEA la decisión: si
  // alguna vez aparece "Aceptado DGI (con observaciones)" de verdad, que la
  // decisión se tome mirando este test y no por accidente.
  it("compara exacto: una variante de 'Aceptado DGI' con texto extra NO cuenta", () => {
    expect(clasificarEstado("Aceptado DGI (con observaciones)")).toBe("desconocido");
    expect(estaAceptado("Aceptado DGI (con observaciones)")).toBe(false);
    // Lo que sí tolera: espacios, caja y tildes, que es variación de formato y
    // no un estado distinto.
    expect(estaAceptado("  aceptado dgi  ")).toBe(true);
  });

  // "Envío no corresponde" es el hallazgo abierto: `esVentaValida` sostiene que
  // debería contar (es una venta real; que no viaje sola a DGI es el canal de
  // reporte, no la validez del documento) y ningún total le hace caso. Este
  // test PINEA la diferencia: el día que se decida cambiarlo, falla acá y se
  // ve, en vez de moverse de arriba de otro cambio.
  it("difiere de esVentaValida solo en 'Envío no corresponde'", () => {
    expect(esVentaValida("Envío no corresponde")).toBe(true);
    expect(estaAceptado("Envío no corresponde")).toBe(false);
    for (const estado of ["Aceptado DGI", "Rechazado DGI", "Pendiente DGI", null, ""]) {
      expect(esVentaValida(estado)).toBe(estaAceptado(estado));
    }
  });
});

/** Todos los .ts de src/, recursivo. */
function archivosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) salida.push(...archivosTs(ruta));
    else if (ruta.endsWith(".ts")) salida.push(ruta);
  }
  return salida;
}

describe("una sola clasificarEstado en todo el proyecto", () => {
  // El bug que este test previene no lo agarra ningún chequeo de tipos: dos
  // funciones con el mismo nombre y distinta semántica compilan perfecto, y el
  // día que un import apunta a la otra los totales se mueven sin ruido.
  it("no hay dos declaraciones de `clasificarEstado`", () => {
    const declaran = archivosTs(SRC_DIR).filter((ruta) =>
      /export function clasificarEstado\b/.test(readFileSync(ruta, "utf8")),
    );
    expect(declaran.map((r) => r.replace(`${SRC_DIR}/`, ""))).toEqual(["services/estadoDgi.ts"]);
  });
});

// --- Consistencia entre tools ------------------------------------------------

/** Un comprobante por clase de estado, todos del mismo importe. */
const UNO_DE_CADA_ESTADO = [
  { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Aceptado DGI", sucursal: 6, fecha_emision: "2026-06-05", tot_iva_tasa_bas: 220, cliente: { documento: "111111111111", razon_social: "A" } },
  { id: 2, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Rechazado DGI", sucursal: 6, fecha_emision: "2026-06-06", tot_iva_tasa_bas: 220, cliente: { documento: "222222222222", razon_social: "B" } },
  { id: 3, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Pendiente DGI", sucursal: 6, fecha_emision: "2026-06-07", tot_iva_tasa_bas: 220, cliente: { documento: "333333333333", razon_social: "C" } },
  { id: 4, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Envío no corresponde", sucursal: 6, fecha_emision: "2026-06-08", tot_iva_tasa_bas: 220, cliente: { documento: "444444444444", razon_social: "D" } },
  { id: 5, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: null, sucursal: 6, fecha_emision: "2026-06-09", tot_iva_tasa_bas: 220, cliente: { documento: "555555555555", razon_social: "E" } },
  { id: 6, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "", sucursal: 6, fecha_emision: "2026-06-10", tot_iva_tasa_bas: 220, cliente: { documento: "666666666666", razon_social: "F" } },
  { id: 7, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Estado Inventado XYZ", sucursal: 6, fecha_emision: "2026-06-11", tot_iva_tasa_bas: 220, cliente: { documento: "777777777777", razon_social: "G" } },
];

const LISTA = normalizeComprobantesEmitidos(UNO_DE_CADA_ESTADO);

/** Período que cubre a todos: el ranking de clientes lo necesita para "dormido". */
const JUNIO = { desde: "2026-06-01", hasta: "2026-06-30" };

describe("el mismo total para los mismos comprobantes", () => {
  // Con siete ventas iguales y una sola aceptada, TODAS las tools que suman
  // plata tienen que contestar 1000. Que el resumen contestara 3000 y el
  // ranking 1000 es exactamente el bug que se arregló.
  it("resumen, ranking de clientes y ranking de sucursales suman lo mismo", () => {
    const resumen = resumirFacturacion(LISTA, { incluir_anulados: false });
    const clientes = rankingClientes(LISTA, JUNIO);
    const sucursales = rankingSucursales(LISTA, null, {});

    const totalClientes = clientes.clientes.reduce(
      (acc, c) => acc + (c.facturado_por_moneda.UYU ?? 0),
      0,
    );
    const totalSucursales = sucursales.sucursales.reduce(
      (acc, s) => acc + (s.facturado_por_moneda.UYU ?? 0),
      0,
    );

    expect(resumen.totales_por_moneda.UYU!.total).toBe(1000);
    expect(totalClientes).toBe(1000);
    expect(totalSucursales).toBe(1000);
    // Y el total de referencia sin filtro de estado sigue disponible.
    expect(resumen.totales_por_moneda_todos_los_estados.UYU!.total).toBe(7000);
  });

  it("la comparación de períodos usa el mismo criterio", () => {
    const r = compararPeriodos(
      LISTA,
      [],
      { desde: "2026-06-01", hasta: "2026-06-30" },
      { desde: "2026-05-01", hasta: "2026-05-31" },
      { hoy: new Date("2026-07-05T12:00:00Z") },
    );
    expect(r.actual.total_por_moneda.UYU).toBe(1000);
  });

  it("la posición de IVA usa el mismo criterio", () => {
    const r = calcularPosicionIva(LISTA, [], {});
    expect(r.por_moneda[0]!.debito.tasa_basica).toBe(220);
  });
});

describe("la exclusión por estado desconocido se avisa", () => {
  // Sin este aviso el criterio estricto no es defendible: el usuario ve un
  // total más bajo y no tiene con qué explicarlo.
  const desconocidos = /sin (un )?estado DGI reconocible/i;

  it("el resumen dice cuántos fueron y cuánto sumaban", () => {
    const r = resumirFacturacion(LISTA, { incluir_anulados: false });
    const aviso = r.warnings.find((w) => desconocidos.test(w));
    expect(aviso).toBeDefined();
    expect(aviso).toMatch(/3 comprobante/);
    expect(aviso).toMatch(/\$3\.000/); // formateado a la uruguaya, como toda la plata
  });

  it("el ranking de clientes avisa", () => {
    expect(rankingClientes(LISTA, JUNIO).warnings.some((w) => desconocidos.test(w))).toBe(true);
  });

  it("el ranking de sucursales avisa", () => {
    expect(
      rankingSucursales(LISTA, null, {}).warnings.some((w) => desconocidos.test(w)),
    ).toBe(true);
  });

  it("la comparación de períodos avisa, porque una variación puede ser del dato", () => {
    const r = compararPeriodos(
      LISTA,
      [],
      { desde: "2026-06-01", hasta: "2026-06-30" },
      { desde: "2026-05-01", hasta: "2026-05-31" },
      { hoy: new Date("2026-07-05T12:00:00Z") },
    );
    expect(r.warnings.some((w) => /estado DGI reconocible/i.test(w))).toBe(true);
  });

  it("la posición de IVA avisa, porque el número se puede terminar pagando", () => {
    const r = calcularPosicionIva(LISTA, [], {});
    expect(r.warnings.some((w) => desconocidos.test(w))).toBe(true);
  });

  it("las cohortes avisan, porque un cliente puede quedar en el mes de alta equivocado", () => {
    const r = calcularCohortes(LISTA, { desde: "2026-06-01", hasta: "2026-06-30" });
    expect(r.warnings.some((w) => desconocidos.test(w))).toBe(true);
  });

  it("no avisa nada cuando todos los estados son legibles", () => {
    const sinDesconocidos = normalizeComprobantesEmitidos(
      UNO_DE_CADA_ESTADO.filter((c) => typeof c.estado === "string" && c.estado.trim() !== "" && c.estado !== "Estado Inventado XYZ"),
    );
    const r = resumirFacturacion(sinDesconocidos, { incluir_anulados: false });
    expect(r.warnings.some((w) => desconocidos.test(w))).toBe(false);
    expect(rankingClientes(sinDesconocidos, JUNIO).warnings.some((w) => desconocidos.test(w))).toBe(
      false,
    );
  });
});

describe("el estado vacío no abre una categoría propia", () => {
  // `clasificarEstado("")` ya trata el vacío como desconocido; el conteo tiene
  // que usar la MISMA normalización. Con `?? "(sin estado)"` no la usaba, y el
  // aviso salía con una entrada sin nombre: "(sin estado): 1, : 1, …" — el
  // mismo comprobante en dos categorías según qué mandó la API.
  const VARIANTES_DE_VACIO = normalizeComprobantesEmitidos([
    { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: null, fecha_emision: "2026-06-05" },
    { id: 2, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "", fecha_emision: "2026-06-06" },
    { id: 3, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "   ", fecha_emision: "2026-06-07" },
  ]);

  it("null, vacío y whitespace caen todos en '(sin estado)'", () => {
    const r = resumirFacturacion(VARIANTES_DE_VACIO, { incluir_anulados: false });
    expect(r.conteo_por_estado).toEqual({ "(sin estado)": 3 });
  });

  it("la enumeración del aviso no tiene entradas sin nombre", () => {
    const r = resumirFacturacion(
      normalizeComprobantesEmitidos([
        { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "", fecha_emision: "2026-06-05" },
        { id: 2, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Chirimbolo raro", fecha_emision: "2026-06-06" },
      ]),
      { incluir_anulados: false },
    );
    const aviso = r.warnings.find((w) => /Se excluyeron/i.test(w));
    expect(aviso).toBeDefined();
    expect(aviso).toMatch(/\(sin estado\): 1/);
    // El síntoma exacto del bug: una coma, un espacio y dos puntos sin etiqueta.
    expect(aviso).not.toMatch(/, : /);
  });

  it("agrupar por estado tampoco abre un grupo con etiqueta vacía", () => {
    const r = resumirFacturacion(VARIANTES_DE_VACIO, {
      incluir_anulados: false,
      solo_aceptados: false,
      agrupar_por: ["estado"],
    });
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]!.etiqueta).toBe("(sin estado)");
    expect(r.grupos[0]!.conteo).toBe(3);
  });
});

describe("los avisos no mienten con solo_aceptados=false", () => {
  // El pecado que este cambio vino a erradicar, con el signo invertido: afirmar
  // "NO se contaron" mientras el filtro está apagado y sí se contaron.
  const UNA_SIN_ESTADO = normalizeComprobantesEmitidos([
    { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: null, sucursal: 6, fecha_emision: "2026-06-05", tot_iva_tasa_bas: 220, cliente: { documento: "111111111111", razon_social: "A" } },
  ]);

  const afirmaQueNoSeContaron = (w: string): boolean => /NO se (contaron|cohortiz)/i.test(w);

  it("ningún warning dice 'NO se contaron' cuando el filtro está apagado", () => {
    const resultados = [
      resumirFacturacion(UNA_SIN_ESTADO, { incluir_anulados: false, solo_aceptados: false }),
      rankingClientes(UNA_SIN_ESTADO, { ...JUNIO, solo_aceptados: false }),
      rankingSucursales(UNA_SIN_ESTADO, null, { solo_aceptados: false }),
      calcularCohortes(UNA_SIN_ESTADO, JUNIO, { solo_aceptados: false }),
      calcularPosicionIva(UNA_SIN_ESTADO, [], { solo_aceptados: false }),
    ];
    for (const r of resultados) {
      expect(r.warnings.filter(afirmaQueNoSeContaron)).toEqual([]);
    }
  });

  it("y el comprobante SÍ está contado, que es lo que el texto tiene que reflejar", () => {
    const ranking = rankingClientes(UNA_SIN_ESTADO, { ...JUNIO, solo_aceptados: false });
    expect(ranking.clientes[0]!.facturado_por_moneda.UYU).toBe(1000);
    expect(ranking.warnings.some((w) => /SÍ están contados/i.test(w))).toBe(true);

    const sucursales = rankingSucursales(UNA_SIN_ESTADO, null, { solo_aceptados: false });
    expect(sucursales.sucursales[0]!.facturado_por_moneda.UYU).toBe(1000);
    expect(sucursales.warnings.some((w) => /SÍ están contados/i.test(w))).toBe(true);
  });
});

describe("la nota de crédito de estado desconocido infla el total, y el aviso lo dice", () => {
  // El caso caro: una venta grande aceptada y su anulación casi total sin
  // estado. El total pasa de 10.000 a 100.000 y el warning es el único cable
  // que lo cuenta.
  const VENTA_Y_NC_SIN_ESTADO = normalizeComprobantesEmitidos([
    { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100000, estado: "Aceptado DGI", fecha_emision: "2026-06-05" },
    { id: 2, tipo_comprobante: 112, moneda: "UYU", total: 90000, estado: null, fecha_emision: "2026-06-06" },
  ]);

  it("el total NO descuenta la NC sin estado y el aviso nombra el monto negativo", () => {
    const r = resumirFacturacion(VENTA_Y_NC_SIN_ESTADO, { incluir_anulados: false });
    expect(r.totales_por_moneda.UYU!.total).toBe(100000);
    // El total de referencia sí la descuenta: es el número con el que comparar.
    expect(r.totales_por_moneda_todos_los_estados.UYU!.total).toBe(10000);

    const aviso = r.warnings.find((w) => /SIN un estado DGI reconocible/i.test(w));
    expect(aviso).toBeDefined();
    // Sin doble negación: el signo lo pone "restaban", no un menos delante del
    // número. "restaban -90.000" se lee al revés de lo que pasó.
    expect(aviso).toMatch(/restaban \$90\.000 en notas de crédito, sin ninguna venta/);
    expect(aviso).not.toMatch(/-\$?90/);
    expect(aviso).toMatch(/INFLADO/);
  });

  // El neto mentía justo acá: +5.000 y −5.000 daban "sumaban $0", o sea
  // "no quedó nada afuera", con diez mil pesos de movimiento afuera.
  it("reporta bruto positivo y bruto negativo, no el neto", () => {
    const netoCero = normalizeComprobantesEmitidos([
      { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 5000, estado: null, fecha_emision: "2026-06-05" },
      { id: 2, tipo_comprobante: 112, moneda: "UYU", total: 5000, estado: null, fecha_emision: "2026-06-06" },
    ]);
    const aviso = resumirFacturacion(netoCero, { incluir_anulados: false }).warnings.find((w) =>
      /SIN un estado DGI reconocible/i.test(w),
    );
    expect(aviso).toMatch(/sumaban \$5\.000 en ventas y restaban \$5\.000 en notas de crédito/);
    expect(aviso).not.toMatch(/sumaban \$0/);
    // Ningún importe del aviso lleva signo menos: la palabra ya dice el sentido.
    expect(aviso).not.toMatch(/-\$/);
  });
});

describe("el ranking de productos también avisa (era el único que no)", () => {
  const CON_ITEMS = normalizeComprobantesEmitidos([
    {
      id: 1, tipo_comprobante: 111, moneda: "UYU", total: 1000, estado: "Aceptado DGI", fecha_emision: "2026-06-05",
      items: [{ concepto: "Café", cantidad: 1, precio: 1000 }],
    },
    {
      id: 2, tipo_comprobante: 111, moneda: "UYU", total: 700, estado: null, fecha_emision: "2026-06-06",
      items: [{ concepto: "Té", cantidad: 1, precio: 700 }],
    },
  ]);

  it("avisa cuántos comprobantes quedaron afuera por estado", () => {
    const r = rankingProductos(CON_ITEMS, {});
    expect(r.productos.map((p) => p.concepto ?? p.codigo)).toEqual(["Café"]);
    expect(r.warnings.some((w) => /sin estado DGI reconocible y NO se contaron/i.test(w))).toBe(true);
  });

  it("no avisa cuando el filtro está apagado", () => {
    const r = rankingProductos(CON_ITEMS, { solo_aceptados: false });
    expect(r.warnings.some((w) => /NO se contaron/i.test(w))).toBe(false);
  });
});

describe("las alertas de rechazo distinguen estado AUSENTE de estado IRRECONOCIBLE", () => {
  // H4: con la clasificación vieja, un texto no reconocido caía en
  // `no_aceptado` y aparecía en el panel de rechazos. La clase `desconocido`
  // unificada lo metía en la misma bolsa que el null y lo hacía desaparecer.
  // Si DGI estrena una redacción de rechazo sin la palabra "rechazado", el
  // comprobante tiene que seguir viéndose: callarse es la dirección mala.
  it("un estado que no reconocemos SÍ genera alerta", () => {
    const r = detectarRechazos(
      normalizeComprobantesEmitidos([
        { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Anulado por DGI" },
      ]),
    );
    expect(r.conteo_total).toBe(1);
    expect(r.por_estado[0]!.estado).toBe("Anulado por DGI");
  });

  it("el estado ausente o vacío NO genera alerta", () => {
    const r = detectarRechazos(
      normalizeComprobantesEmitidos([
        { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: null },
        { id: 2, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "   " },
        { id: 3, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Aceptado DGI" },
      ]),
    );
    expect(r.conteo_total).toBe(0);
  });

  it("los estados conocidos que no son aceptación siguen alertando", () => {
    const r = detectarRechazos(
      normalizeComprobantesEmitidos([
        { id: 1, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Rechazado DGI" },
        { id: 2, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Pendiente DGI" },
        { id: 3, tipo_comprobante: 111, moneda: "UYU", total: 100, estado: "Envío no corresponde" },
      ]),
    );
    expect(r.conteo_total).toBe(3);
    expect(r.por_estado.find((e) => e.estado === "Rechazado DGI")!.severidad).toBe("critica");
  });
});
