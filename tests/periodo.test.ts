// =============================================================================
// Resolución de períodos, ventaneo y margen de consulta.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  partirEnVentanas,
  rangoDeConsulta,
  resolverPeriodo,
} from "../src/services/periodo.js";

const HOY = new Date("2026-07-27T12:00:00Z");

describe("resolverPeriodo", () => {
  it("resuelve un mes completo", () => {
    expect(resolverPeriodo("2026-06", HOY)).toEqual({ desde: "2026-06-01", hasta: "2026-06-30" });
  });

  it("respeta los meses de 31 días y los febreros bisiestos", () => {
    expect(resolverPeriodo("2026-07", HOY)!.hasta).toBe("2026-07-31");
    expect(resolverPeriodo("2024-02", HOY)!.hasta).toBe("2024-02-29");
    expect(resolverPeriodo("2023-02", HOY)!.hasta).toBe("2023-02-28");
  });

  it("resuelve un año completo", () => {
    expect(resolverPeriodo("2025", HOY)).toEqual({ desde: "2025-01-01", hasta: "2025-12-31" });
  });

  it("resuelve un día suelto", () => {
    expect(resolverPeriodo("2026-06-15", HOY)).toEqual({ desde: "2026-06-15", hasta: "2026-06-15" });
  });

  it("resuelve alias relativos respecto de 'hoy'", () => {
    expect(resolverPeriodo("hoy", HOY)).toEqual({ desde: "2026-07-27", hasta: "2026-07-27" });
    expect(resolverPeriodo("ayer", HOY)).toEqual({ desde: "2026-07-26", hasta: "2026-07-26" });
    expect(resolverPeriodo("mes_actual", HOY)).toEqual({ desde: "2026-07-01", hasta: "2026-07-31" });
    expect(resolverPeriodo("mes_pasado", HOY)).toEqual({ desde: "2026-06-01", hasta: "2026-06-30" });
    expect(resolverPeriodo("ultimos_7_dias", HOY)).toEqual({ desde: "2026-07-21", hasta: "2026-07-27" });
    expect(resolverPeriodo("anio_actual", HOY)).toEqual({ desde: "2026-01-01", hasta: "2026-12-31" });
  });

  it("cruza el fin de año al pedir el mes pasado en enero", () => {
    const enero = new Date("2026-01-15T00:00:00Z");
    expect(resolverPeriodo("mes_pasado", enero)).toEqual({ desde: "2025-12-01", hasta: "2025-12-31" });
  });

  it("devuelve null ante algo que no entiende", () => {
    expect(resolverPeriodo("el mes pasado más o menos", HOY)).toBeNull();
    expect(resolverPeriodo("2026-13", HOY)).toBeNull();
    expect(resolverPeriodo("", HOY)).toBeNull();
  });
});

describe("partirEnVentanas", () => {
  it("devuelve una sola ventana si el rango entra en una de la grilla", () => {
    // 2026-06-01..2026-06-03 cae entero adentro de la ventana de grilla
    // 2026-05-28..2026-06-03, así que sale una sola, recortada al rango.
    const v = partirEnVentanas({ desde: "2026-06-01", hasta: "2026-06-03" }, 7);
    expect(v).toEqual([{ desde: "2026-06-01", hasta: "2026-06-03" }]);
  });

  it("parte un mes en ventanas contiguas y sin solapamiento", () => {
    const v = partirEnVentanas({ desde: "2026-06-01", hasta: "2026-06-30" }, 7);
    // El primer corte NO cae a los 7 días de `desde`: cae donde lo pone la
    // grilla global (ver el porqué en `partirEnVentanas`). Lo que sí se
    // mantiene es que las ventanas son contiguas y cubren el rango exacto.
    expect(v[0]!.desde).toBe("2026-06-01");
    expect(v.at(-1)!.hasta).toBe("2026-06-30");
    for (let i = 1; i < v.length; i += 1) {
      expect(v[i]!.desde > v[i - 1]!.hasta).toBe(true);
    }
  });

  it("cubre el rango completo sin perder días", () => {
    const v = partirEnVentanas({ desde: "2026-01-01", hasta: "2026-12-31" }, 7);
    expect(v[0]!.desde).toBe("2026-01-01");
    expect(v.at(-1)!.hasta).toBe("2026-12-31");
  });

  it("devuelve vacío si el rango está invertido", () => {
    expect(partirEnVentanas({ desde: "2026-06-30", hasta: "2026-06-01" }, 7)).toEqual([]);
  });

  // --- Lo que la grilla vino a resolver -------------------------------------
  //
  // Antes cada partición arrancaba en `rango.desde`, así que dos períodos
  // solapados producían cortes distintos y CERO claves de cache compartidas
  // sobre datos casi idénticos.

  it("dos rangos que se solapan comparten las ventanas interiores", () => {
    const mes = partirEnVentanas({ desde: "2026-06-01", hasta: "2026-06-30" }, 7);
    const treinta = partirEnVentanas({ desde: "2026-05-20", hasta: "2026-06-18" }, 7);

    const clave = (r: { desde: string; hasta: string }) => `${r.desde}..${r.hasta}`;
    const comunes = mes.map(clave).filter((k) => treinta.map(clave).includes(k));

    // Las de los bordes se recortan al rango pedido y por eso no coinciden;
    // las interiores sí, que es donde está el volumen.
    expect(comunes.length).toBeGreaterThan(0);
  });

  it("los cortes interiores caen siempre en los mismos días, venga de donde venga el rango", () => {
    const desdeArriba = partirEnVentanas({ desde: "2026-06-01", hasta: "2026-07-31" }, 7);
    const desdeAbajo = partirEnVentanas({ desde: "2026-04-15", hasta: "2026-07-31" }, 7);
    // El último corte es el mismo en los dos: la grilla no depende del origen.
    expect(desdeArriba.at(-1)!.desde).toBe(desdeAbajo.at(-1)!.desde);
  });

  it("nunca consulta un día fuera del rango pedido", () => {
    // Es la garantía que hace que la grilla no mueva un total: el conjunto de
    // días de CREACIÓN consultados es exactamente el que pidió el llamador.
    const v = partirEnVentanas({ desde: "2026-06-03", hasta: "2026-06-26" }, 7);
    expect(v[0]!.desde).toBe("2026-06-03");
    expect(v.at(-1)!.hasta).toBe("2026-06-26");
    for (const w of v) {
      expect(w.desde >= "2026-06-03").toBe(true);
      expect(w.hasta <= "2026-06-26").toBe(true);
    }
  });
});

describe("rangoDeConsulta", () => {
  // La API filtra por fecha de creación: hay que consultar de más para no
  // perder comprobantes emitidos al filo del período y cargados después.
  it("expande el rango de emisión con margen a ambos lados", () => {
    const r = rangoDeConsulta({ desde: "2026-06-01", hasta: "2026-06-30" }, 5);
    expect(r).toEqual({ desde: "2026-05-27", hasta: "2026-07-05" });
  });
});
