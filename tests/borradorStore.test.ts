import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BorradorStoreArchivo,
  BorradorStoreMemoria,
  MAX_SESIONES,
  TTL_BORRADOR_MS,
  claveSesion,
  resolverClaveSesion,
  crearBorradorStore,
  fusionarEstado,
} from "../src/kapso/borradorStore.js";
import type { EstadoEmision } from "../src/kapso/emision.js";
import { handleEmisionGuiada } from "../src/tools/emisionGuiada.js";
import { handleEmitirComprobante } from "../src/tools/write/emitirComprobante.js";
import { makeCtx } from "./helpers.js";

const COMPROBANTE_MINIMO = {
  tipo_comprobante: 101,
  forma_pago: 1,
  sucursal: 6,
  moneda: "UYU",
  montos_brutos: 0,
  cliente: "-",
  items: [{ cantidad: 1, concepto: "Pelota", precio: 200, indicador_facturacion: 3 }],
};

const leerJson = (res: { content: Array<{ text: string }> }): Record<string, any> =>
  JSON.parse(res.content[0]!.text);

describe("claveSesion", () => {
  it("es estable para el mismo número", () => {
    expect(claveSesion("+59899123456")).toBe(claveSesion("+59899123456"));
  });

  it("no contiene el número", () => {
    // La razón de existir de la función. Si el hash tuviera el número adentro,
    // guardarlo en disco sería exactamente lo que se quiso evitar.
    const clave = claveSesion("+59899123456");
    expect(clave).not.toContain("99123456");
    expect(clave).toMatch(/^[0-9a-f]{24}$/);
  });

  it("distingue conversaciones distintas", () => {
    expect(claveSesion("+59899123456")).not.toBe(claveSesion("+59899123457"));
  });
});

describe("fusionarEstado", () => {
  it("lo nuevo pisa lo viejo", () => {
    const r = fusionarEstado({ moneda: "UYU" }, { moneda: "USD" });
    expect(r.moneda).toBe("USD");
  });

  it("un campo ausente NO borra lo guardado", () => {
    // El invariante del módulo: `undefined` es "no me dijeron nada", no
    // "borralo". Sin esto, cada llamada incompleta del agente vaciaría medio
    // borrador — que es el problema que el store vino a resolver.
    const r = fusionarEstado({ moneda: "UYU", forma_pago: 1 }, { moneda: "USD" });
    expect(r.forma_pago).toBe(1);
  });

  it("un false explícito SÍ pisa un true guardado", () => {
    // `montos_brutos: false` no es ausencia: es el usuario diciendo que el IVA
    // se suma aparte. Tratarlo como "no dijo nada" factura 22% de más.
    const r = fusionarEstado({ montos_brutos: true }, { montos_brutos: false });
    expect(r.montos_brutos).toBe(false);
  });

  it("un array de ítems más corto NO borra los guardados", () => {
    // Antes reemplazaba entero, y esto perdía "azúcar": el CFE salía con una
    // línea menos, perfectamente bien formado. El agente NO puede reenviar el
    // array completo aunque quiera — el concepto de cada ítem no vuelve nunca
    // en la respuesta, porque la barrera de salida lo envuelve.
    const r = fusionarEstado(
      { items: [{ concepto: "harina" }, { concepto: "azúcar" }] },
      { items: [{ concepto: "harina", precio: 100 }] },
    );
    expect(r.items).toHaveLength(2);
    expect(r.items?.[0]?.precio).toBe(100);
    expect(r.items?.[1]?.concepto).toBe("azúcar");
  });

  it("un ítem parcial completa el guardado en vez de vaciarlo", () => {
    const r = fusionarEstado(
      { items: [{ concepto: "bolsas de harina", cantidad: 2 }] },
      { items: [{ precio: 6500 }] },
    );
    expect(r.items?.[0]).toEqual({ concepto: "bolsas de harina", cantidad: 2, precio: 6500 });
  });

  it("agregar un ítem vacío al final sigue funcionando", () => {
    // Es la forma que tiene el flujo de decir "seguí preguntando por otro":
    // `siguientePaso` mira siempre el último del array.
    const r = fusionarEstado({ items: [{ concepto: "harina", precio: 100 }] }, { items: [{}, {}] });
    expect(r.items).toHaveLength(2);
    expect(r.items?.[0]?.concepto).toBe("harina");
    expect(r.items?.[1]).toEqual({});
  });

  it("un valor nuevo SÍ pisa al guardado en la misma posición", () => {
    const r = fusionarEstado(
      { items: [{ concepto: "harina", precio: 100 }] },
      { items: [{ precio: 200 }] },
    );
    expect(r.items?.[0]?.precio).toBe(200);
  });
});

describe("BorradorStoreMemoria", () => {
  it("guarda y devuelve", () => {
    const store = new BorradorStoreMemoria();
    store.guardar("s1", { moneda: "UYU" });
    expect(store.leer("s1")?.estado.moneda).toBe("UYU");
  });

  it("una sesión desconocida es null, no un objeto vacío", () => {
    expect(new BorradorStoreMemoria().leer("nunca-vista")).toBeNull();
  });

  it("la revisión sube en cada guardado", () => {
    const store = new BorradorStoreMemoria();
    expect(store.guardar("s1", {}).revision).toBe(1);
    expect(store.guardar("s1", {}).revision).toBe(2);
  });

  it("no mezcla sesiones", () => {
    const store = new BorradorStoreMemoria();
    store.guardar("s1", { moneda: "UYU" });
    store.guardar("s2", { moneda: "USD" });
    expect(store.leer("s1")?.estado.moneda).toBe("UYU");
  });

  it("borrar deja la sesión en null", () => {
    const store = new BorradorStoreMemoria();
    store.guardar("s1", { moneda: "UYU" });
    store.borrar("s1");
    expect(store.leer("s1")).toBeNull();
    expect(store.vivas()).toBe(0);
  });

  it("un borrador vencido NO se reanuda", () => {
    // Decisión 2 del módulo: un borrador de hace tres días trae la fecha y los
    // precios de hace tres días. Reanudarlo en silencio emite un comprobante
    // que el usuario cree que es de hoy.
    let t = new Date("2026-08-17T10:00:00Z").getTime();
    const store = new BorradorStoreMemoria({ ahora: () => new Date(t) });
    store.guardar("s1", { moneda: "UYU" });

    t += TTL_BORRADOR_MS - 1000;
    expect(store.leer("s1")).not.toBeNull();

    t += 2000;
    expect(store.leer("s1")).toBeNull();
  });

  it("leer renueva la posición pero NO el vencimiento", () => {
    // Distinción sutil y a propósito: el TTL cuenta desde el último GUARDADO,
    // no desde la última lectura. Si leer renovara, un agente que consulta en
    // loop mantendría vivo para siempre un borrador que nadie está tocando.
    let t = new Date("2026-08-17T10:00:00Z").getTime();
    const store = new BorradorStoreMemoria({ ahora: () => new Date(t) });
    store.guardar("s1", {});

    t += TTL_BORRADOR_MS / 2;
    expect(store.leer("s1")).not.toBeNull();

    t += TTL_BORRADOR_MS / 2 + 1000;
    expect(store.leer("s1")).toBeNull();
  });

  it("desaloja al pasar el techo de sesiones", () => {
    const store = new BorradorStoreMemoria();
    for (let i = 0; i < MAX_SESIONES + 10; i += 1) store.guardar(`s${i}`, { moneda: "UYU" });
    expect(store.vivas()).toBe(MAX_SESIONES);
    expect(store.leer("s0")).toBeNull();
    expect(store.leer(`s${MAX_SESIONES + 9}`)).not.toBeNull();
  });

  it("el desalojo cae sobre la menos usada, no sobre la más vieja", () => {
    const store = new BorradorStoreMemoria();
    store.guardar("vieja_pero_activa", { moneda: "UYU" });
    for (let i = 0; i < MAX_SESIONES - 1; i += 1) store.guardar(`s${i}`, {});
    store.leer("vieja_pero_activa"); // la toco: pasa al final del orden
    store.guardar("nueva", {}); // esto desaloja una

    expect(store.leer("vieja_pero_activa")).not.toBeNull();
    expect(store.leer("s0")).toBeNull();
  });
});

describe("BorradorStoreArchivo", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "borradores-"));
    path = join(dir, "sub", "borradores.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sobrevive a un reinicio", () => {
    new BorradorStoreArchivo(path).guardar("s1", { moneda: "USD", forma_pago: 2 });
    const otro = new BorradorStoreArchivo(path);
    expect(otro.leer("s1")?.estado).toEqual({ moneda: "USD", forma_pago: 2 });
  });

  it("gana la última línea de cada sesión", () => {
    const store = new BorradorStoreArchivo(path);
    store.guardar("s1", { moneda: "UYU" });
    store.guardar("s1", { moneda: "USD" });
    expect(new BorradorStoreArchivo(path).leer("s1")?.estado.moneda).toBe("USD");
  });

  it("un borrado NO resucita al reiniciar", () => {
    // En un archivo append-only no se puede quitar nada, así que el borrado
    // tiene que ser una línea. Sin eso, "empecemos de nuevo" dura hasta el
    // próximo reinicio y después vuelve el borrador viejo.
    const store = new BorradorStoreArchivo(path);
    store.guardar("s1", { moneda: "UYU" });
    store.borrar("s1");
    expect(new BorradorStoreArchivo(path).leer("s1")).toBeNull();
  });

  it("una línea corrupta no descarta el archivo entero", () => {
    new BorradorStoreArchivo(path).guardar("s1", { moneda: "UYU" });
    writeFileSync(path, `${readFileSync(path, "utf8")}{ esto no es json\n`, "utf8");
    expect(new BorradorStoreArchivo(path).leer("s1")?.estado.moneda).toBe("UYU");
  });

  it("cargar no reescribe lo que acaba de leer", () => {
    const store = new BorradorStoreArchivo(path);
    store.guardar("s1", { moneda: "UYU" });
    const antes = readFileSync(path, "utf8");
    new BorradorStoreArchivo(path);
    expect(readFileSync(path, "utf8")).toBe(antes);
  });

  it("un archivo ilegible degrada a memoria en vez de tirar", () => {
    // El disco no puede cortar la facturación de la empresa. Se pierde la
    // persistencia, no el flujo.
    const store = new BorradorStoreArchivo(dir); // es un directorio, no un archivo
    expect(() => store.guardar("s1", { moneda: "UYU" })).not.toThrow();
    expect(store.leer("s1")?.estado.moneda).toBe("UYU");
  });
});

describe("crearBorradorStore", () => {
  it("sin ruta, memoria", () => {
    expect(crearBorradorStore(undefined)).toBeInstanceOf(BorradorStoreMemoria);
    expect(crearBorradorStore("   ")).toBeInstanceOf(BorradorStoreMemoria);
  });
});

// ---------------------------------------------------------------------------
// La integración: es acá donde el store paga.
// ---------------------------------------------------------------------------

describe("biller_emision_guiada con sesión", () => {
  const SESION = "+59899123456";

  const llamar = async (ctx: any, args: Record<string, unknown>) =>
    leerJson(await handleEmisionGuiada({ sesion: SESION, ...args }, ctx));

  it("sin sesión no guarda nada y lo dice", async () => {
    const { ctx, borradores } = makeCtx();
    const r = leerJson(await handleEmisionGuiada({ clase_receptor: "empresa" }, ctx));
    expect(r.sesion.activa).toBe(false);
    expect(r.sesion.nota).toContain("NO se guardó");
    expect(borradores.vivas()).toBe(0);
  });

  it("el agente puede mandar SOLO el dato nuevo", async () => {
    // El punto entero del store. Antes, el contrato era "mandá todo en cada
    // llamada" y una llamada incompleta hacía retroceder el flujo.
    const { ctx } = makeCtx();
    await llamar(ctx, { clase_receptor: "empresa", documento: "210000000011" });
    const r = await llamar(ctx, { fecha_emision: "17/08/2026" });

    expect(r.estado_entendido.clase_receptor).toBe("empresa");
    expect(r.estado_entendido.documento).toBe("210000000011");
    expect(r.sesion.recuperado_del_store).toContain("clase_receptor");
  });

  it("sin sesión, ese mismo segundo mensaje retrocede el flujo", async () => {
    // La contraprueba del test de arriba: el valor del store se mide contra lo
    // que pasaba sin él.
    const { ctx } = makeCtx();
    const r = leerJson(await handleEmisionGuiada({ fecha_emision: "17/08/2026" }, ctx));
    expect(r.paso).toBe("receptor");
    expect(r.estado_entendido.documento).toBeUndefined();
  });

  it("el texto libre sobrevive en el server sin volver en la respuesta", async () => {
    // Doble invariante: el concepto se guarda (si no, el borrador saldría sin
    // esa línea) pero NO vuelve en la salida, porque `concepto` está en
    // CAMPOS_NO_CONFIABLES y volvería con las marcas de la barrera impresas.
    const { ctx, borradores } = makeCtx();
    await llamar(ctx, { items: [{ concepto: "bolsas de harina", precio: 6500 }] });

    const guardado = borradores.leer(claveSesion(SESION));
    expect(guardado?.estado.items?.[0]?.concepto).toBe("bolsas de harina");

    const r = await llamar(ctx, {});
    expect(JSON.stringify(r)).not.toContain("bolsas de harina");
    expect(r.estado_entendido.items[0].concepto_cargado).toBe(true);
  });

  it("un botón le gana a lo guardado", async () => {
    // Orden no intercambiable: primero se fusiona con el store, y recién
    // después se aplica el id del botón. Es lo último que hizo el usuario.
    const { ctx } = makeCtx();
    await llamar(ctx, { moneda: "UYU" });
    const r = await llamar(ctx, { mensaje: "emision:moneda:USD" });
    expect(r.estado_entendido.moneda).toBe("USD");
  });

  it("reiniciar tira el borrador", async () => {
    const { ctx } = makeCtx();
    await llamar(ctx, { clase_receptor: "empresa", documento: "210000000011" });
    const r = await llamar(ctx, { reiniciar: true });
    expect(r.paso).toBe("receptor");
    expect(r.estado_entendido.documento).toBeUndefined();
    expect(r.sesion.revision).toBe(1);
  });

  it("dos conversaciones distintas no se pisan", async () => {
    const { ctx } = makeCtx();
    await handleEmisionGuiada({ sesion: "+59899111111", moneda: "UYU" }, ctx);
    await handleEmisionGuiada({ sesion: "+59899222222", moneda: "USD" }, ctx);
    const r = leerJson(await handleEmisionGuiada({ sesion: "+59899111111" }, ctx));
    expect(r.estado_entendido.moneda).toBe("UYU");
  });

  it("la métrica del embudo distingue con y sin sesión", async () => {
    const { ctx, metricas } = makeCtx();
    await llamar(ctx, {});
    await handleEmisionGuiada({}, ctx);
    const claves = metricas.instantanea().muestras.map((m) => m.etiquetas.sesion);
    expect(claves).toContain("si");
    expect(claves).toContain("no");
  });

  it("emitir de verdad descarta el borrador", async () => {
    // Sin esto el borrador sobrevive 24 h y la factura siguiente arranca con el
    // cliente y los ítems de la anterior.
    const { ctx, borradores } = makeCtx({
      postResponse: { id: 1, serie: "A", numero: "1" },
      config: { environment: "test", writeEnabled: true },
    });
    await llamar(ctx, { clase_receptor: "empresa" });
    expect(borradores.vivas()).toBe(1);

    const dry = await handleEmitirComprobante(
      { comprobante: COMPROBANTE_MINIMO, sesion: SESION },
      ctx,
    );
    // El dry-run NO borra: si borrara, un 422 dejaría al usuario sin nada.
    expect(borradores.vivas()).toBe(1);

    await handleEmitirComprobante(
      {
        comprobante: COMPROBANTE_MINIMO,
        sesion: SESION,
        confirm: true,
        confirmation_token: (dry.structuredContent as any).confirmation_token,
      },
      ctx,
    );
    expect(borradores.vivas()).toBe(0);
  });

  it("una emisión fallida CONSERVA el borrador", async () => {
    const { ctx, borradores } = makeCtx({
      postStatus: 422,
      postResponse: { error: "falta un campo" },
      config: { environment: "test", writeEnabled: true },
    });
    await llamar(ctx, { clase_receptor: "empresa" });

    const dry = await handleEmitirComprobante(
      { comprobante: COMPROBANTE_MINIMO, sesion: SESION },
      ctx,
    );
    await handleEmitirComprobante(
      {
        comprobante: COMPROBANTE_MINIMO,
        sesion: SESION,
        confirm: true,
        confirmation_token: (dry.structuredContent as any).confirmation_token,
      },
      ctx,
    );
    expect(borradores.vivas()).toBe(1);
  });

  it("el desenlace de la emisión se cuenta: emitido vs rechazado vs preview", async () => {
    // `emision.paso` cuenta dónde queda cada conversación; sin el desenlace, el
    // embudo no distingue una emisión que salió de una que la API rechazó.
    const ok = makeCtx({
      postResponse: { id: 1, serie: "A", numero: "1" },
      config: { environment: "test", writeEnabled: true },
    });
    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE_MINIMO }, ok.ctx);
    await handleEmitirComprobante(
      {
        comprobante: COMPROBANTE_MINIMO,
        confirm: true,
        confirmation_token: (dry.structuredContent as any).confirmation_token,
      },
      ok.ctx,
    );
    const desenlaces = ok.metricas
      .instantanea()
      .muestras.filter((m) => m.nombre === "emision.desenlace")
      .map((m) => m.etiquetas.desenlace);
    expect(desenlaces).toContain("preview");
    expect(desenlaces).toContain("emitido");
  });

  it("el número de la conversación no queda en la respuesta", async () => {
    const { ctx } = makeCtx();
    const r = await llamar(ctx, { clase_receptor: "empresa" });
    expect(JSON.stringify(r)).not.toContain("99123456");
  });
});

// ---------------------------------------------------------------------------
// Regresiones de la revisión de diseño.
// ---------------------------------------------------------------------------

describe("la clave de sesión absorbe el formato", () => {
  it("el mismo teléfono escrito distinto es la MISMA sesión", () => {
    // Sin esto, el borrador se guardaba con una clave y se intentaba borrar con
    // otra: el borrador de un comprobante YA EMITIDO sobrevivía 24 h y la
    // factura siguiente arrancaba con el cliente y los ítems de la anterior.
    const claves = ["099 123 456", "099123456", "099-123-456", "(099) 123.456"].map(claveSesion);
    expect(new Set(claves).size).toBe(1);
  });

  it("un id que NO es teléfono se respeta tal cual (salvo mayúsculas)", () => {
    expect(claveSesion("chat-abc-123")).toBe(claveSesion("Chat-ABC-123"));
    expect(claveSesion("chat-abc-123")).not.toBe(claveSesion("chat-abc-124"));
  });

  it("NO se inventa el código de país", () => {
    // `config.ts` ya decidió que tocarle los dígitos al número es peor que
    // avisar: el 0 nacional uruguayo no es un código de país. Si esto se
    // "arregla", se rompe esa decisión.
    expect(claveSesion("099123456")).not.toBe(claveSesion("59899123456"));
  });

  it("el sesion.id vuelve a caer en su propia sesión", () => {
    // La salida real al problema de formato: el server emite la clave y el
    // agente la repite. Un id opaco no se puede escribir de dos formas.
    const id = claveSesion("099 123 456");
    expect(resolverClaveSesion(id)).toBe(id);
    expect(resolverClaveSesion("099123456")).toBe(id);
  });
});

describe("emitir con una sesión que no existe avisa en vez de callarse", () => {
  it("un borrador que no se borró sale como warning", async () => {
    const { ctx } = makeCtx({
      postResponse: { id: 1, serie: "A", numero: "1" },
      config: { environment: "test", writeEnabled: true },
    });
    await handleEmisionGuiada({ sesion: "099123456", clase_receptor: "empresa" }, ctx);

    // El aviso llega ya en el DRY-RUN, que es cuando todavía se puede corregir
    // el identificador. Después del POST el CFE ya existe y avisar es una
    // autopsia.
    const dry = await handleEmitirComprobante(
      { comprobante: COMPROBANTE_MINIMO, sesion: "otra-conversacion-distinta" },
      ctx,
    );
    const warnings = (dry.structuredContent as any).warnings as string[];
    expect(warnings.some((w) => w.includes("No hay ningún borrador guardado"))).toBe(true);
  });

  it("con el sesion.id devuelto, el borrador SÍ se borra", async () => {
    const { ctx, borradores } = makeCtx({
      postResponse: { id: 1, serie: "A", numero: "1" },
      config: { environment: "test", writeEnabled: true },
    });
    const guiada = leerJson(
      await handleEmisionGuiada({ sesion: "099 123 456", clase_receptor: "empresa" }, ctx),
    );
    expect(borradores.vivas()).toBe(1);

    const dry = await handleEmitirComprobante({ comprobante: COMPROBANTE_MINIMO }, ctx);
    await handleEmitirComprobante(
      {
        comprobante: COMPROBANTE_MINIMO,
        sesion: guiada.sesion.id, // el id opaco, no el teléfono
        confirm: true,
        confirmation_token: (dry.structuredContent as any).confirmation_token,
      },
      ctx,
    );
    expect(borradores.vivas()).toBe(0);
  });
});

describe("dos instancias sobre el mismo archivo", () => {
  // El escenario para el que el store de archivo EXISTE. La primera versión
  // leía el archivo una sola vez, al arrancar: la instancia B seguía sirviendo
  // un borrador que la A ya había emitido, y no veía nada de lo que A guardaba.
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "borradores-multi-"));
    path = join(dir, "borradores.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("B ve lo que A guardó DESPUÉS de que B arrancó", () => {
    const a = new BorradorStoreArchivo(path);
    const b = new BorradorStoreArchivo(path);
    a.guardar("s1", { moneda: "USD" });
    expect(b.leer("s1")?.estado.moneda).toBe("USD");
  });

  it("B deja de servir el borrador que A borró al emitir", () => {
    const a = new BorradorStoreArchivo(path);
    a.guardar("s1", { moneda: "UYU" });
    const b = new BorradorStoreArchivo(path);
    expect(b.leer("s1")).not.toBeNull();
    a.borrar("s1"); // A emitió
    expect(b.leer("s1")).toBeNull();
  });

  it("B puede borrar una sesión que solo conocía A", () => {
    // La emisión puede entrar por cualquier instancia: la que borra no siempre
    // es la que guardó.
    const a = new BorradorStoreArchivo(path);
    a.guardar("s1", { moneda: "UYU" });
    const b = new BorradorStoreArchivo(path);
    b.borrar("s1");
    expect(a.leer("s1")).toBeNull();
    expect(new BorradorStoreArchivo(path).leer("s1")).toBeNull();
  });

  it("la revisión sigue la del archivo, no la de la instancia", () => {
    const a = new BorradorStoreArchivo(path);
    const b = new BorradorStoreArchivo(path);
    a.guardar("s1", {});
    a.guardar("s1", {});
    expect(b.guardar("s1", {}).revision).toBe(3);
  });

  it("un archivo rotado se relee desde cero en vez de servir memoria vieja", () => {
    const a = new BorradorStoreArchivo(path);
    a.guardar("s1", { moneda: "UYU" });
    // Rotación: el archivo nuevo es más chico que lo ya leído.
    writeFileSync(path, "", "utf8");
    expect(a.leer("s1")).toBeNull();
  });
});

describe("numero_interno automático del borrador", () => {
  const llamar = async (ctx: any, args: Record<string, unknown>) =>
    leerJson(await handleEmisionGuiada({ sesion: "+59899123456", ...args }, ctx));

  it("nace con el borrador y NO cambia entre mensajes", async () => {
    // Es la defensa contra emitir dos veces por un retry: un reintento del
    // mismo borrador tiene que llevar el MISMO id para que la API lo frene.
    const { ctx } = makeCtx();
    const r1 = await llamar(ctx, { clase_receptor: "empresa" });
    const r2 = await llamar(ctx, { fecha_emision: "17/08/2026" });
    const id1 = r1.comprobante_borrador.numero_interno;
    expect(id1).toMatch(/^wa-[0-9a-f]{8}-/);
    expect(r2.comprobante_borrador.numero_interno).toBe(id1);
  });

  it("un borrador nuevo (tras reiniciar) lleva OTRO id", async () => {
    const { ctx } = makeCtx();
    const r1 = await llamar(ctx, { clase_receptor: "empresa" });
    const r2 = await llamar(ctx, { reiniciar: true });
    expect(r2.comprobante_borrador.numero_interno).not.toBe(
      r1.comprobante_borrador.numero_interno,
    );
  });

  it("sin sesión no hay id: no hay borrador que lo conserve", async () => {
    const { ctx } = makeCtx();
    const r = leerJson(await handleEmisionGuiada({ clase_receptor: "empresa" }, ctx));
    expect(r.comprobante_borrador.numero_interno).toBeUndefined();
  });
});
