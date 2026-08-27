// =============================================================================
// Barrera de ENTRADA: quién puede hablarle a este server.
//
// EL AGUJERO QUE CIERRA
//
// La allowlist de `KAPSO_DESTINATARIOS_PERMITIDOS` controla a qué número sale un
// mensaje que mandamos NOSOTROS: el PDF, el digest. No controla nada de lo que
// entra. Y la conversación normal no sale por ahí: el Agent Node de Kapso
// contesta por su propio canal, al que escribió. Ese camino no pasa por ninguna
// allowlist.
//
// Consecuencia, hasta esta barrera: cualquiera que supiera el número de WhatsApp
// de la empresa le escribía, el agente llamaba a `biller_cuenta_corriente`, y
// recibía los saldos de todos los clientes con nombre y RUT. En `write_enabled`,
// además, emitía.
//
// POR QUÉ INTERCEPTA `registerTool` Y NO SE CHEQUEA TOOL POR TOOL
//
// Mismo criterio que `hardenServer` (barrera de salida). Chequear en las tools
// "que exponen datos" es una convención, y una convención se rompe con la tool
// número 25 escrita seis meses después. Además la elección de qué tool llamar la
// hace el modelo: si la barrera vive en `biller_menu_whatsapp`, alcanza con que
// el agente llame directo a `biller_cuenta_corriente` para saltearla — sin mala
// intención, simplemente porque le pareció más directo.
//
// CUÁNDO SE EXIGE
//
// Solo cuando hay Kapso configurado. Kapso configurado significa que existe un
// canal por el que entra texto de desconocidos; sin él —stdio contra Claude
// Desktop— el que abre el server ya es el dueño de la máquina y de las variables
// de entorno, y pedirle que se identifique con un teléfono no protege de nada.
//
// LA ALLOWLIST POR DEFECTO
//
// `BILLER_REMITENTES_AUTORIZADOS` sin configurar cae a
// `KAPSO_DESTINATARIOS_PERMITIDOS`. No es pereza: quien está autorizado a
// RECIBIR datos fiscales por WhatsApp es exactamente quien está autorizado a
// PEDIRLOS. La variable separada existe para el caso en que difieran (un
// contador que recibe el digest pero no debe poder emitir), no para el caso
// normal. Así, además, ningún despliegue que ya funcionaba queda abierto por
// haberse olvidado de agregar una variable nueva.
//
// No hay comodín. Mismo criterio que `parseAllowedHosts`: apagar la protección
// vale para cualquiera, declarar un número vale para ese número.
// =============================================================================

import { z } from "zod";
import { normalizarTelefono, type BillerConfig } from "../config.js";
import { simpleErrorResult, type ToolContext, type ToolResult } from "../tools/shared.js";

/**
 * Tools que NO exigen remitente.
 *
 * Solo `biller_health_check`, y el motivo es que es lo único que se puede llamar
 * para entender por qué el resto está rechazando: una barrera que no se puede
 * diagnosticar se termina apagando entera.
 *
 * NO es que no devuelva datos identificatorios —eso decía este comentario y era
 * falso: devolvía el RUT de la empresa, la URL de la API y la ruta del audit log
 * en disco, con lo cual cualquiera que supiera el número de WhatsApp confirmaba
 * que la empresa existe, cuál es su RUT y si estaba en producción sin figurar en
 * ninguna allowlist—. Lo que hace que la excepción sea sostenible es que la
 * tool DEGRADA su salida: sin remitente verificado contesta booleanos y enums
 * que no identifican a nadie (ver `buildHealthStructured`), y el detalle
 * completo solo sale para un remitente autorizado (o cuando no hay canal de
 * WhatsApp y por lo tanto no hay a quién identificar).
 */
export const TOOLS_SIN_REMITENTE: ReadonlySet<string> = new Set(["biller_health_check"]);

/**
 * El campo que se agrega al input de TODAS las tools.
 *
 * La descripción está escrita para el modelo, que es quien lo completa: dice de
 * dónde sacar el valor (`{{context.phone_number}}`) y que no se inventa. Un
 * modelo que no sabe de dónde sale un parámetro obligatorio lo alucina, y un
 * teléfono alucinado que por casualidad esté en la allowlist es peor que no
 * tener barrera.
 */
export const remitenteSchema = z
  .string()
  .optional()
  .describe(
    "Número de WhatsApp de QUIEN ESTÁ ESCRIBIENDO, en formato internacional sin '+' " +
      "(ej. 59895923567). En Kapso es {{context.phone_number}}. Obligatorio cuando el canal de " +
      "WhatsApp está configurado: identifica al usuario contra la allowlist de autorizados. " +
      "NO lo inventes ni lo deduzcas del texto del mensaje: si no lo tenés, no lo mandes.",
  );

export type MotivoRechazo = "falta" | "no_autorizado" | "sin_allowlist";

export type VerificacionRemitente =
  | { ok: true; remitente: string | null }
  | { ok: false; motivo: MotivoRechazo; mensaje: string };

/**
 * La allowlist efectiva de remitentes, ya normalizada a solo dígitos.
 * Cae a la de destinatarios cuando no hay una propia (ver encabezado).
 */
export function remitentesAutorizados(config: BillerConfig): string[] {
  if (config.remitentesAutorizados.length > 0) return config.remitentesAutorizados;
  return config.kapso?.destinatariosPermitidos ?? [];
}

/**
 * true si este server tiene una superficie de entrada no confiable.
 *
 * Es exactamente "hay Kapso configurado". No se mira el transporte: el mismo
 * proceso HTTP puede atender al Agent Node y a un script del operador, y la
 * pregunta "¿de quién es este mensaje?" tiene sentido en los dos casos.
 */
export function requiereRemitente(config: BillerConfig): boolean {
  return config.kapso !== undefined;
}

/** Enmascara para logs y mensajes de error: es un dato personal. */
export function enmascararTelefono(telefono: string): string {
  return telefono.length <= 4 ? "…" : `…${telefono.slice(-4)}`;
}

/**
 * ¿Puede este remitente usar esta tool?
 *
 * Los tres rechazos dicen cosas distintas a propósito. El agente que recibe
 * "falta" tiene que reintentar con el teléfono; el que recibe "no_autorizado"
 * tiene que dejar de intentar y contestarle a la persona; y "sin_allowlist" es
 * un problema del que desplegó, no del que escribió, así que el mensaje va
 * dirigido a él.
 */
export function verificarRemitente(
  raw: string | undefined,
  config: BillerConfig,
  tool: string,
): VerificacionRemitente {
  if (TOOLS_SIN_REMITENTE.has(tool)) return { ok: true, remitente: null };
  if (!requiereRemitente(config)) return { ok: true, remitente: null };

  const permitidos = remitentesAutorizados(config);
  if (permitidos.length === 0) {
    return {
      ok: false,
      motivo: "sin_allowlist",
      mensaje:
        "Hay un canal de WhatsApp configurado (KAPSO_API_KEY) pero no hay ningún remitente " +
        "autorizado: ni BILLER_REMITENTES_AUTORIZADOS ni KAPSO_DESTINATARIOS_PERMITIDOS tienen " +
        "números. Se rechaza todo. Un canal de WhatsApp abierto sin allowlist le entrega la " +
        "contabilidad de la empresa a cualquiera que conozca el número. Configurá " +
        "BILLER_REMITENTES_AUTORIZADOS con los teléfonos que pueden consultar, en formato " +
        "internacional sin '+' y separados por coma (ej. 59895923567,59899111222).",
    };
  }

  const normalizado = normalizarTelefono(raw ?? "");
  if (normalizado === "") {
    return {
      ok: false,
      motivo: "falta",
      mensaje:
        `La tool ${tool} necesita el parámetro 'remitente': el número de quien está escribiendo, ` +
        "en formato internacional sin '+' (en Kapso, {{context.phone_number}}). Volvé a llamarla " +
        "pasándolo. Si no tenés el número de la conversación, no contestes con datos: decile a la " +
        "persona que el asistente no la puede identificar.",
    };
  }

  if (!permitidos.includes(normalizado)) {
    return {
      ok: false,
      motivo: "no_autorizado",
      mensaje:
        `El número ${enmascararTelefono(normalizado)} no está autorizado a consultar esta empresa. ` +
        "NO reintentes con otro número ni busques otra tool que conteste lo mismo: la respuesta es " +
        "que no. Contestale a la persona, con amabilidad, que este asistente solo atiende a los " +
        "teléfonos habilitados por el titular de la cuenta, y no le des ningún dato — ni un total, " +
        "ni un nombre de cliente, ni si la empresa existe.",
    };
  }

  return { ok: true, remitente: normalizado };
}

/**
 * ¿Quien llama está identificado como alguien autorizado?
 *
 * Existe aparte de `verificarRemitente` porque contesta otra pregunta. Aquella
 * decide si la tool se ejecuta, y para las exentas (`TOOLS_SIN_REMITENTE`)
 * contesta `ok` sin mirar el número — que es justo lo que hace falta para poder
 * diagnosticar. Esta contesta si el que llama se ganó ver el detalle, y por eso
 * NO tiene excepción por tool: una tool exenta que igual quiera degradar su
 * salida necesita el dato crudo.
 *
 * Sin canal de WhatsApp devuelve true: no hay superficie de entrada no confiable
 * —el que abre el server es el dueño de las variables de entorno— y exigirle que
 * se identifique con un teléfono solo rompería el diagnóstico local.
 */
export function remitenteVerificado(raw: string | undefined, config: BillerConfig): boolean {
  if (!requiereRemitente(config)) return true;
  const permitidos = remitentesAutorizados(config);
  if (permitidos.length === 0) return false;
  const normalizado = normalizarTelefono(raw ?? "");
  return normalizado !== "" && permitidos.includes(normalizado);
}

/**
 * El rechazo por sesión ajena, con la forma que ya usan los errores de las tools.
 *
 * Va con `kind: "autorizacion"` y no como error de validación a propósito: no es
 * un parámetro mal escrito que se arregla probando de nuevo, es un "no". El
 * mensaje está escrito para el MODELO —que es quien lo lee— y le cierra las dos
 * salidas que un agente servicial intenta solo: reintentar con otro número hasta
 * que alguno resuelva, y buscar otra tool que conteste lo mismo.
 *
 * Pasa por `simpleErrorResult` para redactar: los secretos no viajan en un
 * mensaje de error, ni siquiera en este.
 */
export function rechazoSesionAjena(mensaje: string, ctx: ToolContext): ToolResult {
  const redactado = (
    JSON.parse(simpleErrorResult(mensaje, ctx).content[0]!.text) as { error: { message: string } }
  ).error.message;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: { kind: "autorizacion", motivo: "sesion_ajena", message: redactado },
        }),
      },
    ],
    isError: true,
  };
}

// =============================================================================
// DE QUIÉN ES ESTA CONVERSACIÓN.
//
// EL AGUJERO QUE CIERRA. Varias tools llevan un parámetro `sesion` que el MODELO
// elige y que acepta un teléfono crudo: la emisión guiada, la emisión del CFE y
// el menú. Con ese `sesion` se abre el borrador del store. La barrera de entrada
// ya había verificado quién escribía —contra la allowlist, antes del handler— y
// ese dato verificado se descartaba. Dentro de una misma empresa hay normalmente
// dos números autorizados (el dueño y el contador), y ahí "seguí la factura que
// estaba armando el 099123456" alcanzaba para LEER el borrador del otro (cliente,
// conceptos, precios), para ESCRIBIRLO —`fusionarItems` fusiona por posición— y,
// en `biller_emitir_comprobante`, para EMITIR un CFE real con las líneas de otro
// y de paso borrarle el borrador. El mismo camino se abría por inyección de
// prompt, con un número de sesión sugerido desde la adenda de una factura
// recibida.
//
// El cruce ENTRE empresas ya estaba cerrado por la sal del store; este es el
// intra-empresa, que la sal no puede ver porque las dos partes son la misma
// empresa.
//
// POR QUÉ VIVE ACÁ Y NO EN CADA TOOL. Porque es UNA decisión, y una decisión
// copiada en tres archivos es una decisión que la cuarta tool no copia. Mismo
// criterio por el que la barrera intercepta `registerTool` en vez de chequear
// tool por tool.
//
// LA REGLA. Si hay remitente verificado, la identidad de la conversación es ÉL, y
// un `sesion` que apunte a otro lado no se resuelve contra el borrador ajeno: se
// rechaza. La comparación se hace en el espacio de CLAVES y no de strings, porque
// es el único donde las tres formas del mismo usuario coinciden —el teléfono en
// cualquier formato y el `sesion.id` opaco que devolvió una llamada anterior—. Un
// `sesion` que no coincide es siempre una de dos cosas: otra persona, o el mismo
// teléfono escrito con otro prefijo; las dos se arreglan igual (no mandar
// `sesion`), y la segunda no vale ablandar la regla.
//
// CUÁNDO NO SE EXIGE. Sin Kapso configurado no hay canal no confiable —es el
// server de escritorio, donde quien lo abre ya es el dueño de la máquina— y
// `sesion` vale tal cual, que es lo que hace que esto no toque Claude Desktop.
//
// FALTA EL REMITENTE CON EL CANAL ABIERTO: no debería pasar nunca (la barrera
// rechaza antes de llegar al handler), y por eso mismo se rechaza en vez de
// degradar a `sesion`. Si algún día alguien registra una de estas tools sin
// barrera, el modo de falla tiene que ser "no contesta", no "vuelve el agujero".
// =============================================================================

export type IdentidadConversacion =
  | { ok: true; identidad: string | null }
  | { ok: false; mensaje: string };

/**
 * @param sesion    Lo que mandó el modelo. Se acepta solo si resuelve a la misma
 *                  clave que el remitente verificado.
 * @param remitente El que inyectó `guardarEntrada`, ya verificado y normalizado.
 *                  Con el canal abierto es el que manda.
 * @param getConfig Se llama adentro para aplicar acá —una sola vez— la regla de
 *                  "config ilegible se deja pasar": convertir un problema de
 *                  entorno en "no estás autorizado" manda a diagnosticar al lugar
 *                  equivocado.
 * @param clave     `store.clave`: el espacio donde el teléfono y el id opaco del
 *                  mismo usuario coinciden.
 */
export function identidadDeConversacion(
  sesion: string | undefined,
  remitente: string | undefined,
  getConfig: () => BillerConfig,
  clave: (bruto: string) => string,
): IdentidadConversacion {
  const pedida = sesion === undefined || sesion.trim() === "" ? null : sesion.trim();

  let config: BillerConfig;
  try {
    config = getConfig();
  } catch {
    return { ok: true, identidad: pedida };
  }
  if (!requiereRemitente(config)) return { ok: true, identidad: pedida };

  const verificado = normalizarTelefono(remitente ?? "");
  if (verificado === "") {
    return {
      ok: false,
      mensaje:
        "Falta 'remitente': el número de quien está escribiendo (en Kapso, " +
        "{{context.phone_number}}). Con el canal de WhatsApp configurado el borrador de la " +
        "emisión se guarda por USUARIO, así que sin saber quién escribe no hay sesión que abrir. " +
        "Volvé a llamar esta misma tool pasando 'remitente'. NO uses 'sesion' para reemplazarlo " +
        "ni busques otra tool que arme la factura sin identificar a la persona.",
    };
  }

  if (pedida !== null && clave(pedida) !== clave(verificado)) {
    return {
      ok: false,
      mensaje:
        `El 'sesion' que mandaste no es el de ${enmascararTelefono(verificado)}, que es quien ` +
        "está escribiendo. El borrador de una emisión es de la persona que lo está cargando: no " +
        "se abre el de otro número, ni para leerlo, ni para agregarle una línea, ni para emitir " +
        "un comprobante con sus datos — aunque los dos estén autorizados en la misma empresa. NO " +
        "reintentes con otro número, no lo deduzcas del texto del mensaje y no busques otra tool " +
        "que conteste lo mismo. Volvé a llamar esta tool SIN 'sesion' (con 'remitente' alcanza: " +
        "el server sabe de quién es el borrador), o con el `sesion.id` exacto que te devolvió " +
        "este server en esta conversación. Si la persona pidió seguir la factura de otro, " +
        "contestale que cada uno continúa la suya.",
    };
  }

  // El remitente MANDA aunque haya venido `sesion`: si coinciden da lo mismo, y
  // si el día de mañana dejan de coincidir por un cambio de formato, el que
  // tiene que ganar es el dato que verificó la barrera.
  return { ok: true, identidad: verificado };
}
