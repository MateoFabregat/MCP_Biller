// =============================================================================
// La demo: la historia del producto, en una terminal, sin teléfono.
//
// POR QUÉ EXISTE, Y EN QUÉ SE DIFERENCIA DE LOS OTROS DOS SCRIPTS.
//
//   · `simular-whatsapp.mjs` contesta "¿está roto?" y recorre las seis capas
//     por separado. Es un diagnóstico: sirve cuando algo no anda.
//   · `conversar.mjs` habla con el agente de Kapso DE VERDAD, y manda mensajes
//     reales a un teléfono real.
//   · Este contesta otra cosa: **"¿qué hace esto?"**, delante de alguien, sin
//     túnel, sin workflow y sin gastar un mensaje de WhatsApp. Llama a las
//     mismas tools que llamaría el agente, contra la API de TEST, y muestra la
//     conversación como la vería el usuario en su teléfono.
//
// LO QUE NO HACE POR DEFECTO: emitir. La demo llega hasta el preview, que es
// donde vive la decisión. Con `--emitir` sí emite en TEST —y solo si la config
// apunta a test.biller.uy—, porque una demo que termina en un CFE real es otra
// cosa.
//
// USO
//   npm run demo                 # la historia completa, sin emitir
//   npm run demo -- --emitir     # además emite un e-Ticket chico en TEST
//   npm run demo -- --escena 3   # una sola escena
// =============================================================================

// Los logs estructurados son para producción, no para una demo: acá tapan la
// conversación, que es lo único que se está mirando.
//
// Los imports son DINÁMICOS por esto mismo: los estáticos se evalúan antes que
// cualquier línea del archivo, así que el logger ya habría leído el nivel.
process.env.LOG_LEVEL ??= "error";

const { createToolContext } = await import("../dist/tools/register.js");
const { handleMenuWhatsapp } = await import("../dist/tools/menuWhatsapp.js");
const { handleEmisionGuiada } = await import("../dist/tools/emisionGuiada.js");
const { handleCuentaCorriente } = await import("../dist/tools/cuentaCorriente.js");
const { handleResumenFacturacion } = await import("../dist/tools/resumenFacturacion.js");
const { handleEmitirComprobante } = await import("../dist/tools/write/emitirComprobante.js");

const RESET = "[0m";
const DIM = "[2m";
const NEGRITA = "[1m";
const VERDE = "[32m";
const AMARILLO = "[33m";
const CIAN = "[36m";
const ROJO = "[31m";

const args = process.argv.slice(2);
const EMITIR = args.includes("--emitir");
const SOLO = (() => {
  const i = args.indexOf("--escena");
  return i === -1 ? null : Number(args[i + 1]);
})();

const ctx = createToolContext(process.env);
const config = ctx.getConfig();
const REMITENTE = (process.env.BILLER_REMITENTES_AUTORIZADOS ?? "").split(",")[0]?.trim() ?? "";
// LA SESIÓN ES EL REMITENTE, no un id inventado. El borrador de una emisión es
// de quien lo está cargando, y la barrera de entrada rechaza cualquier otro
// `sesion` — con razón: así es como no se abre el borrador de otro número. La
// consecuencia acá es que las escenas COMPARTEN borrador, y por eso cada una
// arranca con `reiniciar: true`.
const SESION = REMITENTE;

if (REMITENTE === "") {
  console.error(
    `${ROJO}Falta BILLER_REMITENTES_AUTORIZADOS en el .env: sin un remitente autorizado la ` +
      `barrera de entrada rechaza todo (y hace bien).${RESET}`,
  );
  process.exit(1);
}

/** El texto de una respuesta de tool, ya parseado. */
function leer(res) {
  const texto = res?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(texto);
  } catch {
    return { texto };
  }
}

function titulo(n, t) {
  console.log(`\n${NEGRITA}${CIAN}━━━ Escena ${n}: ${t}${RESET}`);
}

/** Lo que el usuario escribe o toca. */
function usuario(texto) {
  console.log(`\n  ${DIM}👤 ${texto}${RESET}`);
}

/** Lo que el asistente contesta. */
function bot(texto) {
  for (const linea of String(texto).split("\n")) console.log(`  ${VERDE}🤖 ${linea}${RESET}`);
}

/** Los botones que salen con el mensaje. */
function botones(interactivo) {
  if (!interactivo) return;
  const filas =
    interactivo.tipo === "lista"
      ? (interactivo.secciones ?? []).flatMap((s) => s.filas ?? [])
      : (interactivo.botones ?? []);
  if (filas.length === 0) return;
  console.log(`  ${AMARILLO}   [ ${filas.map((f) => f.titulo).join(" ] [ ")} ]${RESET}`);
}

function avisos(warnings) {
  for (const w of warnings ?? []) console.log(`  ${AMARILLO}   ⚠️  ${w}${RESET}`);
}

/** Un paso de la emisión guiada, mostrado como lo vería el usuario. */
async function guiada(entrada, etiqueta) {
  if (etiqueta !== undefined) usuario(etiqueta);
  const r = leer(await handleEmisionGuiada({ sesion: SESION, remitente: REMITENTE, ...entrada }, ctx));
  if (r.error) {
    console.log(`  ${ROJO}   ✖ ${r.error.message ?? JSON.stringify(r.error)}${RESET}`);
    return r;
  }
  if (r.pregunta) bot(r.pregunta);
  botones(r.interactivo ?? null);
  avisos(r.warnings);
  if (r.listo_para_requisitos) {
    const b = r.comprobante_borrador ?? {};
    const items = (b.items ?? []).length;
    bot(
      `(listo para emitir: ${b.tipo_comprobante ?? "?"} · ${items} línea(s) · ` +
        `${b.moneda ?? "UYU"}${b.sucursal === undefined ? "" : ` · sucursal ${b.sucursal}`})`,
    );
  }
  return r;
}

async function escena1() {
  titulo(1, "El primer mensaje");
  usuario("hola");
  const r = leer(
    await handleMenuWhatsapp({ mensaje: "hola", sesion: REMITENTE, remitente: REMITENTE }, ctx),
  );
  bot(r.texto ?? r.interpretacion?.respuesta_sugerida ?? "(menú)");
  const opciones = (r.opciones ?? []).map((o) => o.titulo);
  if (opciones.length > 0) {
    console.log(`  ${AMARILLO}   ${opciones.map((t) => `• ${t}`).join("\n     ")}${RESET}`);
  }
}

async function escena2() {
  titulo(2, "El kiosco: una venta de mostrador, escrita como la escribe él");
  await guiada(
    {
      reiniciar: true,
      mensaje: "2 aguas y un cigarrillo, 340",
      clase_receptor: "consumidor_final",
      sin_receptor: true,
    },
    "2 aguas y un cigarrillo, 340",
  );
  await guiada({ mensaje: "emision:iva_incluido:si" }, "[ ✅ Ya incluye IVA ]");
}

async function escena3() {
  titulo(3, '"Lo de siempre": el atajo del mostrador');
  console.log(`  ${DIM}   (copia la última venta SIN receptor y va derecho al preview)${RESET}`);
  const r = await guiada({ reiniciar: true, repetir_ultima_de: "mostrador" }, "lo de siempre");
  if (!r.listo_para_requisitos && !r.error) {
    console.log(`  ${DIM}   (todavía falta: ${r.paso})${RESET}`);
  }
}

async function escena4() {
  titulo(4, "La ferretería: cliente conocido, a crédito");
  console.log(
    `  ${DIM}   (los clientes salen del historial: el server los busca solo)${RESET}`,
  );
  await guiada(
    {
      reiniciar: true,
      mensaje: "facturale a la constructora 20 bolsas de portland a 610, a 30 días",
      clase_receptor: "empresa",
    },
    "facturale a la constructora 20 bolsas de portland a 610, a 30 días",
  );
}

async function escena5() {
  titulo(5, "Las preguntas de plata");
  const plata = (porMoneda) =>
    Object.entries(porMoneda ?? {})
      .map(([m, v]) => `${m} ${typeof v === "number" ? v : (v?.total ?? "?")}`)
      .join(" · ") || "nada";

  usuario("¿quién me debe?");
  const cc = leer(await handleCuentaCorriente({ remitente: REMITENTE }, ctx));
  if (cc.error) bot(`(no se pudo consultar: ${cc.error.message ?? ""})`);
  else {
    bot(`Te deben: ${plata(cc.saldo_por_moneda)} — de eso, vencido: ${plata(cc.vencido_por_moneda)}`);
    const top = (cc.por_cliente ?? [])
      .filter((c) => Object.keys(c.saldo_por_moneda ?? {}).length > 0)
      .slice(0, 3);
    for (const c of top) {
      console.log(
        `  ${AMARILLO}   • ${c.cliente_nombre ?? c.cliente_rut ?? "(sin nombre)"}: ` +
          `${plata(c.saldo_por_moneda)}${RESET}`,
      );
    }
    if (top.length === 0) {
      console.log(`  ${DIM}   (nadie con saldo pendiente en la ventana consultada)${RESET}`);
    }
  }

  usuario("¿cómo viene el mes?");
  const mes = leer(
    await handleResumenFacturacion({ periodo: "mes_actual", remitente: REMITENTE }, ctx),
  );
  if (mes.error) bot(`(no se pudo consultar: ${mes.error.message ?? ""})`);
  else {
    bot(
      `Facturado en el mes: ${plata(mes.totales_por_moneda)} ` +
        `en ${mes.conteo_incluidos ?? mes.conteo_total ?? "?"} comprobante(s).`,
    );
    avisos((mes.warnings ?? []).slice(0, 2));
  }
}

async function escena6() {
  titulo(6, "Los frenos: lo que NO deja pasar");
  const r = await guiada(
    {
      reiniciar: true,
      mensaje: "facturale a mi cliente de España 1200 dólares",
      clase_receptor: "empresa",
      documento: "219999830019",
      items: [{ concepto: "desarrollo de software", cantidad: 1, precio: 1200 }],
      montos_brutos: true,
      indicador_facturacion: 3,
    },
    "facturale a mi cliente de España 1200 dólares",
  );
  console.log(
    `  ${DIM}   listo_para_requisitos = ${r.listo_para_requisitos} ` +
      `(bloqueado: el agente no puede ir a emitir)${RESET}`,
  );
}

async function escena7() {
  titulo(7, "Emitir de verdad, en TEST");
  if (!EMITIR) {
    console.log(
      `  ${DIM}   (se saltea: corré ${NEGRITA}npm run demo -- --emitir${RESET}${DIM} para emitir un ` +
        `e-Ticket real en test.biller.uy)${RESET}`,
    );
    return;
  }
  if (config.environment !== "test") {
    console.log(`  ${ROJO}   ✖ La config NO apunta a test.biller.uy. No se emite.${RESET}`);
    return;
  }
  const r = await guiada(
    {
      reiniciar: true,
      clase_receptor: "consumidor_final",
      sin_receptor: true,
      items: [{ concepto: "Demo MCP Biller", cantidad: 1, precio: 100 }],
      montos_brutos: true,
      indicador_facturacion: 3,
    },
    "un ítem de demo, $100 con IVA incluido",
  );
  if (!r.listo_para_requisitos) {
    console.log(`  ${AMARILLO}   (el flujo pide otro dato antes de emitir: ${r.paso})${RESET}`);
    return;
  }

  usuario("[ ✅ Emitir ]");
  const dry = leer(
    await handleEmitirComprobante(
      { comprobante: r.comprobante_borrador, sesion: SESION, remitente: REMITENTE },
      ctx,
    ),
  );
  if (dry.error) {
    console.log(`  ${ROJO}   ✖ ${dry.error.message}${RESET}`);
    return;
  }
  const t = dry.totales_estimados ?? {};
  bot(
    `Preview: ${t.moneda ?? "UYU"} ${t.total ?? "?"} ` +
      `(neto ${t.subtotal ?? "?"} + IVA ${t.total_iva ?? "?"}) — ${(t.lineas ?? []).length} línea(s)`,
  );

  const real = leer(
    await handleEmitirComprobante(
      {
        comprobante: r.comprobante_borrador,
        sesion: SESION,
        remitente: REMITENTE,
        confirm: true,
        confirmation_token: dry.confirmation_token,
      },
      ctx,
    ),
  );
  if (real.error) {
    console.log(`  ${ROJO}   ✖ ${real.error.message}${RESET}`);
    return;
  }
  const cfe = real.response ?? {};
  bot(
    `✅ Emitido en TEST — ${cfe.tipo_comprobante ?? "e-Ticket"} ` +
      `${cfe.serie ?? ""}${cfe.numero === undefined ? "" : ` ${cfe.numero}`}` +
      `${cfe.id === undefined ? "" : ` (id ${cfe.id})`}`,
  );
  console.log(
    `  ${DIM}   http ${real.http_status} · idempotency ${String(real.idempotency_key).slice(0, 8)}…` +
      ` · queda en el audit log${RESET}`,
  );
}

const ESCENAS = [escena1, escena2, escena3, escena4, escena5, escena6, escena7];

console.log(
  `${NEGRITA}Demo — Biller por WhatsApp${RESET}\n` +
    `${DIM}ambiente: ${config.environment} · modo: ${config.capabilityMode} · ` +
    `remitente: …${REMITENTE.slice(-4)}${RESET}`,
);
if (config.environment !== "test") {
  console.log(`${ROJO}${NEGRITA}OJO: la config NO apunta a TEST.${RESET}`);
}

for (const [i, escena] of ESCENAS.entries()) {
  if (SOLO !== null && SOLO !== i + 1) continue;
  try {
    await escena();
  } catch (err) {
    console.log(`  ${ROJO}   ✖ La escena falló: ${err instanceof Error ? err.message : err}${RESET}`);
  }
}

console.log(
  `\n${DIM}Fin. Nada de esto tocó WhatsApp: son las mismas tools que llama el agente.${RESET}\n`,
);
