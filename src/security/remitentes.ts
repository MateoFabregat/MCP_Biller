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

/**
 * Tools que NO exigen remitente.
 *
 * Solo `biller_health_check`: no toca la API de Biller, no devuelve un solo dato
 * fiscal —ni un importe, ni un cliente, ni un RUT— y es lo único que se puede
 * llamar para entender por qué el resto está rechazando. Una barrera que no se
 * puede diagnosticar se termina apagando entera.
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
