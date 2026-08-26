#!/usr/bin/env node
// =============================================================================
// Dar de alta una empresa, verificando contra la API REAL.
//
// POR QUÉ EXISTE
//
// Poner una empresa nueva son ~25 variables de entorno, y varias no fallan al
// arrancar sino MUCHO después:
//
//   · `BILLER_DEFAULT_SUCURSAL_ID` mal (el clásico "1" en vez del id real, 347)
//     arranca perfecto y devuelve 422 recién al emitir — con el cliente esperando.
//   · Un número de la allowlist con el 0 nacional adentro (598095923567) no
//     coincide nunca, y el envío se rechaza sin decir por qué.
//   · El valor de la UI se vence y nadie se entera hasta que un e-Ticket grande
//     sale sin receptor identificado.
//
// `biller_health_check` dice si la configuración está COMPLETA. Esto dice si
// está BIEN, que no es lo mismo: lo único que distingue una de otra es llamar a
// la API de verdad. Es la misma lección que ya dejó escrita la doc del proyecto
// —cuatro de siete comportamientos verificados contradicen al OpenAPI— aplicada
// al alta de un cliente nuevo.
//
// USO
//
//   node scripts/onboard.mjs                 # la empresa del .env del proceso
//   node scripts/onboard.mjs --tenant=panaderia   # una del registro multi-empresa
//   node scripts/onboard.mjs --json          # salida para un pipeline
//
// NO ESCRIBE NADA. Solo GET: no emite, no da de alta, no manda mensajes. Se
// puede correr contra producción sin miedo.
// =============================================================================

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const modoJson = args.includes("--json");
const tenantPedido = (args.find((a) => a.startsWith("--tenant=")) ?? "").split("=")[1] ?? null;

// --- Entorno efectivo (con overlay del tenant si se pidió uno) --------------

function cargarEnv() {
  let env = { ...process.env };

  // .env no se parsea con dependencias: cuatro líneas alcanzan y este script
  // tiene que poder correr en una máquina recién clonada.
  try {
    for (const linea of readFileSync(".env", "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linea);
      if (m && env[m[1]] === undefined) {
        env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* sin .env: se usan solo las del proceso */
  }

  if (tenantPedido === null) return { env, tenant: null };

  const inline = (env.BILLER_TENANTS_JSON ?? "").trim();
  const ruta = (env.BILLER_TENANTS_PATH ?? "").trim();
  if (inline === "" && ruta === "") {
    fatal(
      `Pediste --tenant=${tenantPedido} pero no hay registro de empresas ` +
        "(ni BILLER_TENANTS_JSON ni BILLER_TENANTS_PATH).",
    );
  }
  const registro = JSON.parse(inline !== "" ? inline : readFileSync(ruta, "utf8"));
  const tenant = registro.find((t) => t.id === tenantPedido);
  if (tenant === undefined) {
    fatal(
      `No hay ninguna empresa con id "${tenantPedido}". Las que hay: ` +
        registro.map((t) => t.id).join(", "),
    );
  }
  return { env: { ...env, ...tenant.env }, tenant };
}

function fatal(mensaje) {
  console.error(`✗ ${mensaje}`);
  process.exit(2);
}

// --- Los chequeos -----------------------------------------------------------

const resultados = [];

function anotar(estado, titulo, detalle) {
  resultados.push({ estado, titulo, detalle });
}

const ok = (t, d) => anotar("ok", t, d);
const falta = (t, d) => anotar("falta", t, d);
const aviso = (t, d) => anotar("aviso", t, d);

async function get(env, path, query = {}) {
  const url = new URL(path, env.BILLER_API_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.BILLER_API_TOKEN}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    cuerpo = texto.slice(0, 400);
  }
  return { status: res.status, cuerpo };
}

/** aaaa-mm-dd de hace `dias` días. */
function haceDias(dias) {
  const d = new Date(Date.now() - dias * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { env, tenant } = cargarEnv();
  const nombre = tenant?.nombre ?? tenant?.id ?? "(la empresa del entorno)";

  // 1. Lo mínimo, antes de gastar una request.
  if (!env.BILLER_API_BASE_URL) fatal("Falta BILLER_API_BASE_URL.");
  if (!env.BILLER_API_TOKEN) fatal("Falta BILLER_API_TOKEN.");

  const ambiente = /^test\./i.test(new URL(env.BILLER_API_BASE_URL).host) ? "test" : "production";
  ok("Ambiente", `${env.BILLER_API_BASE_URL} → ${ambiente}`);

  // 2. El token, contra la API. Es el único chequeo que no puede fallar
  //    silenciosamente: sin token válido no hay nada más que verificar.
  const sonda = await get(env, "/v2/comprobantes/obtener", {
    fecha_desde: `${haceDias(7)} 00:00:00`,
    fecha_hasta: `${haceDias(0)} 23:59:59`,
    ...(env.BILLER_DEFAULT_SUCURSAL_ID ? { sucursal: env.BILLER_DEFAULT_SUCURSAL_ID } : {}),
  });

  if (sonda.status === 401 || sonda.status === 403) {
    falta("Token de Biller", `La API contestó ${sonda.status}: el token no sirve para esta empresa.`);
  } else if (sonda.status >= 500) {
    aviso(
      "Token de Biller",
      `La API contestó ${sonda.status}. Puede ser el rango de fechas (Biller devuelve 500 con ` +
        "rangos grandes en vez de paginar) o un problema del lado de ellos. Reintentá.",
    );
  } else if (sonda.status >= 400) {
    // Un 422 acá suele ser la sucursal: es EL error que no se ve hasta emitir.
    falta(
      "Consulta de comprobantes",
      `La API contestó ${sonda.status}: ${JSON.stringify(sonda.cuerpo).slice(0, 300)}. ` +
        (env.BILLER_DEFAULT_SUCURSAL_ID
          ? `Revisá BILLER_DEFAULT_SUCURSAL_ID="${env.BILLER_DEFAULT_SUCURSAL_ID}": tiene que ser el ` +
            "ID REAL que Biller asigna en Ajustes → Sucursales (ej. 347), no un número genérico como 1."
          : "Probá configurando BILLER_DEFAULT_SUCURSAL_ID."),
    );
  } else {
    const cantidad = Array.isArray(sonda.cuerpo) ? sonda.cuerpo.length : 0;
    ok(
      "Token de Biller",
      `Responde. ${cantidad} comprobantes en los últimos 7 días` +
        (env.BILLER_DEFAULT_SUCURSAL_ID ? ` (sucursal ${env.BILLER_DEFAULT_SUCURSAL_ID})` : ""),
    );
    if (cantidad === 0) {
      aviso(
        "Sin movimiento reciente",
        "No hay comprobantes en los últimos 7 días. No es un error, pero significa que el " +
          "resolvedor de clientes y productos no tiene contra qué resolver todavía: si esta empresa " +
          "factura seguido, revisá que la sucursal sea la correcta.",
      );
    }
  }

  // 3. Sucursal declarada pero sin nombre: los reportes van a decir "sucursal 347".
  if (env.BILLER_DEFAULT_SUCURSAL_ID && !env.BILLER_SUCURSALES_JSON) {
    aviso(
      "Nombres de sucursal",
      "Sin BILLER_SUCURSALES_JSON los reportes dicen \"sucursal " +
        `${env.BILLER_DEFAULT_SUCURSAL_ID}\" en vez del nombre. Ej: {"${env.BILLER_DEFAULT_SUCURSAL_ID}":"Centro"}`,
    );
  }

  // 4. El certificado de DGI: vencido, la empresa no puede emitir. Es el chequeo
  //    que más vale la pena hacer ANTES de prender el número, no después.
  if (env.BILLER_DEFAULT_EMPRESA_RUT) {
    const cert = await get(env, "/v2/dgi/empresas/certificado-unico", {
      rut: env.BILLER_DEFAULT_EMPRESA_RUT,
    });
    if (cert.status >= 400) {
      aviso("Certificado DGI", `No se pudo consultar (${cert.status}).`);
    } else {
      const c = cert.cuerpo ?? {};
      const vence = String(c.Vencimiento ?? "").trim();
      const estado = String(c.Estado ?? "").trim();
      if (vence === "") {
        // Tercer estado real: "NO existe Certificado de Vigencia Anual", con
        // Emision/Vencimiento en whitespace puro.
        falta("Certificado DGI", `Sin certificado vigente. Estado: "${estado || "(vacío)"}".`);
      } else {
        ok("Certificado DGI", `${c.Denominacion ?? ""} — vence ${vence} (estado: ${estado})`);
      }
    }
  } else {
    aviso(
      "RUT de la empresa",
      "Sin BILLER_DEFAULT_EMPRESA_RUT no se puede verificar el certificado de DGI ni etiquetar los " +
        "reportes con el nombre de la empresa.",
    );
  }

  // 5. El canal de WhatsApp y —lo importante— quién puede usarlo.
  if (env.KAPSO_API_KEY) {
    const remitentes = (env.BILLER_REMITENTES_AUTORIZADOS ?? "").split(",").filter((s) => s.trim());
    const destinatarios = (env.KAPSO_DESTINATARIOS_PERMITIDOS ?? "").split(",").filter((s) => s.trim());
    const efectivos = remitentes.length > 0 ? remitentes : destinatarios;

    if (efectivos.length === 0) {
      falta(
        "Quién puede preguntar",
        "Hay canal de WhatsApp y NINGÚN remitente autorizado: el server va a rechazar todo. " +
          "Configurá BILLER_REMITENTES_AUTORIZADOS. Sin allowlist, cualquiera que conozca el número " +
          "lee la contabilidad de la empresa.",
      );
    } else {
      ok(
        "Quién puede preguntar",
        `${efectivos.length} teléfono(s) autorizado(s)` +
          (remitentes.length > 0 ? "" : " (heredados de KAPSO_DESTINATARIOS_PERMITIDOS)"),
      );
    }

    for (const crudo of [...remitentes, ...destinatarios]) {
      const d = crudo.replace(/\D/g, "");
      if (/^5980/.test(d)) {
        falta(
          "Formato de teléfono",
          `…${d.slice(-4)} lleva el 0 nacional después del 598. En formato internacional ese 0 no ` +
            "va: 095 923 567 se escribe 59895923567. Tal como está, no va a coincidir nunca.",
        );
      } else if (d.length < 8 || d.length > 15) {
        falta("Formato de teléfono", `…${d.slice(-4)} tiene ${d.length} dígitos (válido: 8 a 15).`);
      }
    }

    if (!env.KAPSO_PHONE_NUMBER_ID) {
      falta("Kapso", "Falta KAPSO_PHONE_NUMBER_ID: sin él no se puede enviar nada.");
    } else {
      ok("Kapso", `Configurado (phone_number_id ${env.KAPSO_PHONE_NUMBER_ID}).`);
    }
  } else {
    ok("Canal de WhatsApp", "Sin configurar. El server corre en modo escritorio (stdio).");
  }

  // 6. El valor de la UI se vence. Un umbral viejo hace que un e-Ticket grande
  //    salga sin receptor identificado, que es un problema fiscal, no de UX.
  if (env.BILLER_VALOR_UI) {
    const fecha = env.BILLER_VALOR_UI_FECHA;
    const dias = fecha ? Math.round((Date.now() - Date.parse(fecha)) / 86_400_000) : null;
    if (dias === null) {
      aviso("Valor de la UI", `Configurado (${env.BILLER_VALOR_UI}) pero sin BILLER_VALOR_UI_FECHA.`);
    } else if (dias > 90) {
      falta("Valor de la UI", `El valor es del ${fecha}: hace ${dias} días. Actualizalo.`);
    } else {
      ok("Valor de la UI", `${env.BILLER_VALOR_UI} al ${fecha} (hace ${dias} días).`);
    }
  } else {
    aviso(
      "Valor de la UI",
      "Sin BILLER_VALOR_UI se usa un valor de referencia conservador y los avisos del umbral de " +
        "5.000 UI salen marcados como aproximados.",
    );
  }

  // 7. Escritura en producción: que quede dicho en voz alta.
  if (ambiente === "production" && env.BILLER_WRITE_ENABLED === "true") {
    aviso(
      "Escritura en PRODUCCIÓN",
      "Habilitada. Cada emisión genera un documento fiscal real ante DGI. Se corrige (nota de " +
        "crédito), pero cada corrección es otro comprobante con su propia numeración.",
    );
  }

  // --- Salida ---------------------------------------------------------------

  const faltantes = resultados.filter((r) => r.estado === "falta");

  if (modoJson) {
    console.log(JSON.stringify({ empresa: nombre, ambiente, listo: faltantes.length === 0, resultados }, null, 2));
  } else {
    const icono = { ok: "✓", aviso: "!", falta: "✗" };
    console.log(`\nAlta de empresa: ${nombre}\n`);
    for (const r of resultados) {
      console.log(`  ${icono[r.estado]} ${r.titulo}`);
      console.log(`      ${r.detalle}\n`);
    }
    console.log(
      faltantes.length === 0
        ? "✓ Lista para atender.\n"
        : `✗ Faltan ${faltantes.length} cosa(s) antes de prender el número.\n`,
    );
  }

  process.exit(faltantes.length === 0 ? 0 : 1);
}

main().catch((err) => fatal(err instanceof Error ? err.message : String(err)));
