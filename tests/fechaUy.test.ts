// =============================================================================
// Qué día es hoy en Uruguay.
//
// Los tests corren con el TZ de la máquina de quien los corre, así que todos
// pasan un instante EXPLÍCITO: si dependieran de la zona local, pasarían en
// Montevideo y fallarían en CI —que corre en UTC—, que es exactamente el bug
// que este módulo vino a cerrar.
// =============================================================================

import { describe, expect, it } from "vitest";
import { hoyDgiUy, hoyIsoUy } from "../src/services/fechaUy.js";
import { hoyDgi } from "../src/kapso/emision.js";
import { resolverPeriodo } from "../src/services/periodo.js";

/** 22:30 del 25 de agosto en Montevideo = 01:30 del 26 en UTC. */
const NOCHE = new Date("2026-08-26T01:30:00Z");
/** Mediodía, donde UTC y Montevideo coinciden en el día. */
const MEDIODIA = new Date("2026-08-25T15:00:00Z");

describe("la noche uruguaya no es el día siguiente", () => {
  it("a las 22:30 de Montevideo sigue siendo el 25, no el 26", () => {
    expect(NOCHE.toISOString().slice(0, 10)).toBe("2026-08-26"); // lo que decía antes
    expect(hoyIsoUy(NOCHE)).toBe("2026-08-25"); // lo que corresponde
  });

  it("`hoyDgi` —la fecha que termina en el CFE— usa el día uruguayo", () => {
    // Un CFE con la fecha de mañana no se corrige: se anula con una nota de
    // crédito. Este es el test más caro de los que fallaban.
    expect(hoyDgi(NOCHE)).toBe("25/08/2026");
  });

  it("de día no cambia nada", () => {
    expect(hoyIsoUy(MEDIODIA)).toBe("2026-08-25");
    expect(hoyDgiUy(MEDIODIA)).toBe("25/08/2026");
  });

  it('"hoy" como período también es el día uruguayo', () => {
    // Después de las 21:00, "¿cuánto vendí hoy?" armaba el rango del día
    // siguiente y contestaba cero.
    expect(resolverPeriodo("hoy", NOCHE)).toEqual({ desde: "2026-08-25", hasta: "2026-08-25" });
  });

  it("`hoyDgi` y el período no pueden estar en días distintos", () => {
    // El peor modo de falla no era ninguno de los dos por separado: era que el
    // comprobante se emitiera con una fecha y el resumen lo buscara en otra.
    const rango = resolverPeriodo("hoy", NOCHE)!;
    const [dd, mm, aaaa] = hoyDgi(NOCHE).split("/");
    expect(`${aaaa}-${mm}-${dd}`).toBe(rango.desde);
  });
});
