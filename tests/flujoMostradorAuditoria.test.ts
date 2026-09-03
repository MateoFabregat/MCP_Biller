// =============================================================================
// Los tres casos que la auditoría del flujo encontró antes de conectar el
// Agent Node. Los tres los pisa una persona en su primera factura.
// =============================================================================

import { describe, expect, it } from "vitest";
import { handleEmisionGuiada } from "../src/tools/emisionGuiada.js";
import { handleMenuWhatsapp } from "../src/tools/menuWhatsapp.js";
import { interpretarRespuestaLibre, siguientePaso, type EstadoEmision } from "../src/kapso/emision.js";
import { interpretarMensaje } from "../src/kapso/menu.js";
import { makeCtx } from "./helpers.js";

const SESION = "59895923567";
const j = (r: { content: Array<{ text: string }> }): Record<string, any> =>
  JSON.parse(r.content[0]!.text);

describe("✖️ Cancelar descarta la factura, no la deja esperando", () => {
  it("después de cancelar, la próxima emisión arranca de cero", async () => {
    // EL CASO CARO: el usuario cancela el preview de Pérez, atiende a otro
    // cliente y pide facturar. Con el borrador vivo le llegaba OTRA VEZ el
    // preview de la factura que acababa de cancelar, con ✅ Emitir a un toque.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });

    const cargado = j(
      await handleEmisionGuiada(
        {
          sesion: SESION,
          clase_receptor: "consumidor_final",
          sin_receptor: true,
          items: [{ concepto: "bolsas de portland", cantidad: 2, precio: 6500 }],
          montos_brutos: true,
          indicador_facturacion: 3,
        },
        ctx,
      ),
    );
    expect(cargado.paso).toBe("confirmar");

    const cancel = j(await handleMenuWhatsapp({ mensaje: "emitir:no", sesion: SESION }, ctx));
    expect(cancel.interpretacion.via).toBe("emision_cancelada");

    const denuevo = j(await handleEmisionGuiada({ sesion: SESION }, ctx));
    expect(denuevo.paso).toBe("receptor");
    expect(denuevo.estado_entendido?.items).toBeUndefined();
  });
});

describe("la pregunta del IVA entiende su propia respuesta escrita", () => {
  const estado: EstadoEmision = {
    clase_receptor: "consumidor_final",
    sin_receptor: true,
    fecha_emision: "03/09/2026",
    items: [{ concepto: "queso", cantidad: 2, precio: 490 }],
    items_cerrados: true,
  };

  it('"sí" y "no" contestan si el precio ya lleva el IVA', () => {
    expect(siguientePaso(estado).paso).toBe("iva");
    for (const si of ["si", "sí", "con iva", "ya incluye", "iva incluido"]) {
      expect(interpretarRespuestaLibre(si, "iva"), si).toEqual({
        paso: "montos_brutos",
        incluye_iva: true,
      });
    }
    for (const no of ["no", "sin iva", "mas iva", "se suma aparte"]) {
      expect(interpretarRespuestaLibre(no, "iva"), no).toEqual({
        paso: "montos_brutos",
        incluye_iva: false,
      });
    }
  });

  it('un "no" adentro del flujo NO es "frená todo"', () => {
    // Era el peor: contestaba "no" a la pregunta del IVA —o sea, "se suma
    // aparte"— y el agente recibía "NO emitas nada de lo que estaba pendiente".
    expect(interpretarMensaje("no", { en_flujo: true }).via).toBe("flujo_emision");
    // En frío sigue siendo una cancelación: ahí no hay pregunta abierta.
    expect(interpretarMensaje("no", { en_flujo: false }).via).toBe("cancelacion");
    // Y cancelar de verdad se sigue diciendo con todas las letras.
    expect(interpretarMensaje("cancelá", { en_flujo: true }).via).toBe("cancelacion");
  });

  it("la otra pregunta de IVA —la de la tasa— se contesta con su propio vocabulario", () => {
    // Las dos preguntas devuelven `paso: "iva"`, así que las separa lo que se
    // contesta: "básica" no contesta "¿ya incluye IVA?" y "sí" no contesta
    // "¿qué IVA lleva?".
    expect(interpretarRespuestaLibre("basica", "iva")).toEqual({
      paso: "iva",
      indicador_facturacion: 3,
    });
    expect(interpretarRespuestaLibre("minima", "iva")).toEqual({
      paso: "iva",
      indicador_facturacion: 2,
    });
    expect(interpretarRespuestaLibre("exento", "iva")).toEqual({
      paso: "iva",
      indicador_facturacion: 1,
    });
  });

  it("el paso separado de montos_brutos contesta igual", () => {
    expect(interpretarRespuestaLibre("si", "precio_incluye_iva")).toEqual({
      paso: "montos_brutos",
      incluye_iva: true,
    });
  });
});

describe("el RUT escrito se lee: la pregunta no rebota su propia respuesta", () => {
  it("acepta RUT y cédula, con o sin puntos, con o sin preámbulo", () => {
    for (const t of ["219999830019", "21.999.983.0019", "el rut es 219999830019", "RUT 21 999 983 0019"]) {
      expect(interpretarRespuestaLibre(t, "cliente"), t).toEqual({
        paso: "cliente",
        documento: "219999830019",
      });
    }
    expect(interpretarRespuestaLibre("1.234.567-8", "cliente")).toEqual({
      paso: "cliente",
      documento: "12345678",
    });
  });

  it("no confunde una corrección de cantidades con un documento", () => {
    expect(interpretarRespuestaLibre("eran 3 no 2", "cliente")).toEqual({ paso: "ninguna" });
    expect(interpretarRespuestaLibre("2 bolsas a 6500", "cliente")).toEqual({ paso: "ninguna" });
  });

  it("sigue entendiendo el 'sin identificar' de siempre", () => {
    expect(interpretarRespuestaLibre("sin datos", "cliente")).toEqual({
      paso: "cliente_sin_identificar",
    });
  });
});

describe("las preguntas de fecha aceptan lo que ellas mismas sugieren", () => {
  it('"30 días" contesta el vencimiento, y también una fecha escrita', () => {
    // La pregunta dice: 'Decime la fecha (dd/mm/aaaa) o en cuántos días (por
    // ejemplo "30 días")'. No tiene botones: si no lee ninguna de las dos
    // formas, la única salida era que el agente CALCULARA la fecha — y el
    // prompt le prohíbe hacer cuentas.
    const HOY = "03/09/2026";
    expect(interpretarRespuestaLibre("30 días", "fecha_vencimiento", HOY)).toEqual({
      paso: "vencimiento",
      fecha: "03/10/2026",
    });
    expect(interpretarRespuestaLibre("a 15 dias", "fecha_vencimiento", HOY)).toEqual({
      paso: "vencimiento",
      fecha: "18/09/2026",
    });
    expect(interpretarRespuestaLibre("15/10/2026", "fecha_vencimiento", HOY)).toEqual({
      paso: "vencimiento",
      fecha: "15/10/2026",
    });
  });

  it("una fecha imposible no se acepta ni se corrige en silencio", () => {
    expect(interpretarRespuestaLibre("31/02/2026", "fecha_vencimiento", "03/09/2026")).toEqual({
      paso: "ninguna",
    });
    expect(interpretarRespuestaLibre("31/02/2026", "fecha", "03/09/2026")).toEqual({
      paso: "ninguna",
    });
  });

  it("la fecha de emisión escrita ya no se pierde", () => {
    expect(interpretarRespuestaLibre("15/08/2026", "fecha", "03/09/2026")).toEqual({
      paso: "fecha_elegida",
      fecha: "15/08/2026",
    });
    expect(interpretarRespuestaLibre("hoy", "fecha", "03/09/2026")).toEqual({ paso: "fecha_hoy" });
  });

  it("el retroceso de '✏️ Otra fecha' sobrevive al mensaje siguiente", async () => {
    // EL RETROCESO DURA DOS MENSAJES: uno para pedirlo y otro para decir la
    // fecha. Antes la intención vivía en una variable del turno, así que en el
    // segundo mensaje el default ya había repuesto "hoy" y la fecha escrita se
    // perdía sin decir nada: la factura salía fechada hoy.
    const { ctx } = makeCtx({ config: { capabilityMode: "write_enabled" } });
    const base = {
      sesion: SESION,
      clase_receptor: "consumidor_final" as const,
      sin_receptor: true,
      items: [{ concepto: "queso", cantidad: 1, precio: 490 }],
      montos_brutos: true,
      indicador_facturacion: 3,
    };
    const pidio = j(await handleEmisionGuiada({ ...base, mensaje: "emision:fecha:otra" }, ctx));
    expect(pidio.paso).toBe("fecha");

    const conFecha = j(await handleEmisionGuiada({ sesion: SESION, mensaje: "15/08/2026" }, ctx));
    expect(conFecha.estado_entendido?.fecha_emision).toBe("15/08/2026");
    expect(conFecha.paso).toBe("confirmar");
  });
});

describe("una fila de la lista de clientes siempre se puede tocar", () => {
  it("no se ofrece un cliente sin documento: tocarlo no resolvía nada", async () => {
    const { construirListaClientes } = await import("../src/kapso/render.js");
    const lista = construirListaClientes([
      { nombre: "Pérez SRL", documento: "219999830019" },
      { nombre: "El de la esquina" },
    ]);
    const filas = lista.secciones[0]!.filas;
    expect(filas.map((f) => f.titulo)).toEqual(["Pérez SRL", "➕ Otro cliente"]);
  });
});
