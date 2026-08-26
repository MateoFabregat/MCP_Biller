// =============================================================================
// biller_emision_guiada
//
// El paso que faltaba entre "quiero facturar" y `biller_requisitos_comprobante`.
//
// `requisitos` exige `tipo_comprobante` como ENTRADA. Pero el dueño de la PyME
// no sabe si necesita un 101 o un 111 — y no tiene por qué saberlo. Esta tool
// hace la pregunta que él sí sabe contestar ("¿a quién le facturás?"), DEDUCE el
// tipo de comprobante, y devuelve la siguiente pregunta con el mensaje tocable
// ya armado.
//
// Devuelve además `comprobante_borrador`: el cuerpo parcial con la forma exacta
// que espera `biller_emitir_comprobante`. Eso saca del modelo la tarea de armar
// el payload campo por campo, que es donde se cuelan los errores caros (un
// `indicador_facturacion` inventado es un CFE con el IVA mal).
//
// NO EMITE NADA y no toca la red fiscal. Se puede llamar mil veces.
// =============================================================================

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizarTelefono } from "../config.js";
import { fusionarEstado, resolverClaveSesion, type BorradorStore } from "../kapso/borradorStore.js";
import { KapsoClient } from "../kapso/client.js";
import {
  aplicarDefaults,
  clasificarDocumento,
  construirDesempateReceptor,
  construirListaClientes,
  construirSubmenuIva,
  hoyDgi,
  interpretarPaso,
  separarDireccionCiudad,
  siguientePaso,
  sugiereDolares,
  PREFIJO_PASO,
  tipoComprobanteSugerido,
  type ClaseReceptor,
  type EstadoEmision,
  type ItemEnCurso,
} from "../kapso/emision.js";
import { extractClienteRut } from "../biller/normalize.js";
import { fetchEmitidos } from "../biller/queries.js";
import { hoyComoDateUy, hoyIsoUy } from "../services/fechaUy.js";
import { formatearUy, parsearCantidad, parsearImporte } from "../services/importe.js";
import { aIso, consultarPorPeriodo } from "../services/periodo.js";
import {
  elegirComprobanteARepetir,
  estadoDesdeComprobante,
  type ResultadoRepeticion,
} from "../services/repetirUltima.js";
import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/**
 * `precio` y `cantidad` aceptan STRING además de número, y eso es a propósito.
 *
 * Si el tipo fuera solo `number`, el que convierte "6.500" en un número es el
 * modelo — y `Number("6.500")` es 6.5, porque en JavaScript el punto es decimal
 * y en Uruguay es de miles. Ese error no se ve: 6.5 es un precio válido, el CFE
 * sale bien formado, y la factura dice seis pesos con cincuenta.
 *
 * Aceptando el texto crudo, la conversión la hace `parsearImporte` con las
 * reglas escritas y testeadas, y los casos genuinamente ambiguos vuelven
 * marcados para que se confirmen antes de emitir. Ver `services/importe.ts`.
 */
const itemShape = z.object({
  concepto: z.string().optional(),
  cantidad: z.union([z.number(), z.string()]).optional(),
  precio: z.union([z.number(), z.string()]).optional(),
  indicador_facturacion: z.number().int().optional(),
});

const inputShape = {
  mensaje: z
    .string()
    .optional()
    .describe(
      "Lo que escribió o tocó el usuario. Si es el id de un botón de este flujo " +
        '("emision:receptor:empresa", "emision:iva:3"…) se interpreta y se incorpora al estado.',
    ),
  clase_receptor: z
    .enum(["empresa", "consumidor_final"])
    .optional()
    .describe(
      "A quién se le factura. 'empresa' (tiene RUT) deriva en e-Factura 111; 'consumidor_final' " +
        "en e-Ticket 101. Si no lo sabés, no lo pases: la tool devuelve la pregunta para averiguarlo.",
    ),
  documento: z
    .string()
    .optional()
    .describe("RUT (12 dígitos) o cédula (7-8) del receptor. La tool clasifica cuál es."),
  nombre_cliente: z.string().optional().describe("Razón social o nombre del receptor."),
  fecha_emision: z
    .string()
    .optional()
    .describe(
      "Fecha del comprobante en dd/mm/aaaa. NO HACE FALTA MANDARLA: si no viene, es hoy, y el " +
        'preview lo dice. Mandala solo cuando el usuario nombró otra ("la de ayer", "para el viernes").',
    ),
  sin_receptor: z
    .boolean()
    .optional()
    .describe(
      "true si el usuario dijo que NO identifica al cliente (venta de mostrador). Solo vale para " +
        "consumidor final. Sin esto el flujo sigue pidiendo el documento.",
    ),
  cliente_ya_facturado: z
    .boolean()
    .optional()
    .describe(
      "¿Ya se le facturó antes a este cliente? Averigualo con biller_listar_comprobantes_emitidos " +
        "(cliente_rut). Si es false, el flujo pide dirección y ciudad: Biller EXIGE esos dos campos " +
        "para dar de alta un cliente durante la emisión y sin ellos devuelve 422.",
    ),
  direccion_cliente: z
    .string()
    .optional()
    .describe(
      "Dirección del cliente. Solo para clientes nuevos. Podés mandar dirección y ciudad juntas tal " +
        'como las escribió el usuario ("Rivera 1234, Melo"): la tool las separa por la última coma.',
    ),
  ciudad_cliente: z.string().optional().describe("Ciudad del cliente. Solo para clientes nuevos."),
  items: z
    .array(itemShape)
    .optional()
    .describe(
      "Lo que se está vendiendo, con lo que se sepa hasta ahora. El ÚLTIMO ítem del array es el que " +
        "se está cargando: el flujo pide concepto, precio e IVA de a uno por vez. La cantidad NO se " +
        "pregunta (si no viene, es 1 y el preview la muestra como '1 × concepto'), así que mandala " +
        'solo si el usuario la dijo. Para agregar otro ítem, sumá un objeto vacío al final.',
    ),
  items_cerrados: z
    .boolean()
    .optional()
    .describe(
      "true cuando el usuario dijo que no agrega más ítems. Ya casi nunca hace falta: el flujo va al " +
        "preview apenas el ítem está completo, y agregar otro es el botón ➕ de ahí.",
    ),
  adenda: z
    .string()
    .optional()
    .describe(
      "Nota al pie del comprobante, con las palabras del usuario. Ya NO se pregunta: mandala cuando " +
        'el usuario la dicte solo ("ponele una nota: orden 4471"), en cualquier momento del flujo.',
    ),
  sin_adenda: z
    .boolean()
    .optional()
    .describe("true si el usuario dijo que no quiere adenda. Ya no cambia ningún camino del flujo."),
  indicador_facturacion: z
    .number()
    .int()
    .optional()
    .describe("Tratamiento de IVA por defecto para los ítems: 3 básica (22%), 2 mínima (10%), 1 exento."),
  moneda: z
    .string()
    .optional()
    .describe(
      "UYU o USD. NO HACE FALTA MANDARLA: el default es UYU. La tool mira el 'mensaje' y, si el " +
        "usuario habló de dólares, devuelve la pregunta en vez de defaultear.",
    ),
  tasa_cambio: z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      "Pesos por unidad de la moneda extranjera (ej. 40). Solo si moneda != UYU. Sin esto, el " +
        "chequeo del umbral de 5.000 UI no se puede hacer sobre un comprobante en dólares.",
    ),
  montos_brutos: z
    .boolean()
    .optional()
    .describe(
      "true si los precios que dio el usuario YA INCLUYEN IVA (precio de mostrador), false si el " +
        "IVA se suma aparte. NO lo adivines: si el usuario no lo dijo, no lo mandes y la tool " +
        "devuelve la pregunta. Equivocarse acá cambia la factura en un 22%. Es lo ÚNICO que el " +
        "flujo sigue preguntando de la parte administrativa, y por eso mismo: es la que mueve plata.",
    ),
  fecha_vencimiento: z
    .string()
    .optional()
    .describe(
      "Vencimiento en dd/mm/aaaa. Obligatorio cuando forma_pago=2 (crédito): sin esto la venta no " +
        'aparece en "¿quién me debe?" ni en vencimientos.',
    ),
  forma_pago: z
    .number()
    .int()
    .optional()
    .describe(
      "1 contado, 2 crédito. NO HACE FALTA MANDARLA: el default es contado, y el preview lo dice. " +
        'Mandá 2 cuando el usuario lo diga ("es a crédito", "me paga a 30 días").',
    ),
  clientes_frecuentes: z
    .array(z.object({ nombre: z.string(), documento: z.string().optional() }))
    .optional()
    .describe(
      "Clientes para ofrecer como lista tocable, sacados de biller_ranking_clientes. Si venís de " +
        "ahí, pasalos: elegir de una lista es un toque y escribir un RUT son doce dígitos.",
    ),
  repetir_ultima_de: z
    .string()
    .optional()
    .describe(
      'Para "facturale lo de siempre a Pérez": RUT o CI del cliente. El server busca su última ' +
        "venta aceptada, copia ítems, precios, IVA y forma de pago al borrador, y el flujo va DERECHO " +
        "al preview: la fecha es de hoy por default (nunca se copia la vieja) y sale escrita ahí. Si " +
        "la venta copiada era a crédito, se pregunta el vencimiento, que sí es de hoy en adelante. " +
        "Requiere 'sesion'. Los conceptos quedan guardados del lado del server: al emitir, pasá la " +
        "misma sesion y se completan solos.",
    ),
  sesion: z
    .string()
    .optional()
    .describe(
      "Identificador de la conversación — normalmente el número de WhatsApp del usuario. Si lo " +
        "pasás, el server GUARDA el borrador y lo usa como base en la próxima llamada: no hace falta " +
        "que repitas todo lo anterior, alcanza con el dato nuevo. PASALO SIEMPRE que exista una " +
        "conversación: es lo que hace que el flujo no se pierda si te falta un campo. El número no " +
        "se guarda: se guarda un hash.",
    ),
  reiniciar: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "true tira el borrador guardado de esa sesión y arranca de cero. Usalo cuando el usuario dice " +
        '"no, dejá" o "empecemos de nuevo".',
    ),
  enviar: z
    .boolean()
    .optional()
    .default(false)
    .describe("Si es true, manda el mensaje tocable del paso actual por WhatsApp."),
  destinatario: z.string().optional().describe("Número en formato internacional. Obligatorio si enviar=true."),
};

const inputSchema = z.object(inputShape);

const outputShape = {
  paso: z.string(),
  pregunta: z.string(),
  listo_para_requisitos: z.boolean(),
  tipo_comprobante: z.number().nullable(),
  tipo_etiqueta: z.string().nullable(),
  tipo_motivo: z.string().nullable(),
  estado_entendido: z.record(z.unknown()),
  /**
   * Qué campos completó el sistema porque el usuario no los dijo: fecha (hoy),
   * moneda (UYU), forma de pago (contado), cantidad (1). Todos aparecen en el
   * preview antes de emitir; esta lista existe para que el agente pueda
   * mencionarlos si el usuario pregunta, y para poder contarlos.
   */
  defaults_aplicados: z.array(z.string()),
  comprobante_borrador: z.record(z.unknown()),
  /** Qué le falta al borrador y de dónde sacarlo. Ver `borradorComprobante`. */
  completar: z.array(z.string()),
  documento_detectado: z
    .object({ tipo: z.string(), normalizado: z.string(), clase: z.string().nullable(), detalle: z.string() })
    .nullable(),
  como_sigue: z.string(),
  /** Estado del borrador guardado. Ver `kapso/borradorStore.ts`. */
  sesion: z.object({
    activa: z.boolean(),
    /**
     * La clave opaca de esta sesión. Repetila tal cual en las próximas llamadas
     * y en `biller_emitir_comprobante`: es exacta, mientras que un teléfono
     * escrito distinto dos veces son dos sesiones.
     */
    id: z.string().nullable(),
    /** Cuántas veces se guardó este borrador. Sube de a uno por mensaje del usuario. */
    revision: z.number().nullable(),
    /** Qué se recuperó del store que NO había venido en esta llamada. */
    recuperado_del_store: z.array(z.string()),
    nota: z.string(),
  }),
  envio: z.object({
    solicitado: z.boolean(),
    realizado: z.boolean(),
    motivo: z.string().nullable(),
    destinatario_sufijo: z.string().nullable(),
    message_id: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
};

/**
 * Aplica un dato al ítem que se está cargando (el último del array).
 *
 * Existe porque los botones de un paso de ítem —la cantidad, por ahora— llegan
 * sin decir a QUÉ ítem pertenecen: el id de un botón de WhatsApp no lleva
 * índice. La convención es la misma que usa `siguientePaso`: el ítem en curso
 * es siempre el último. Si no hay ninguno, se crea.
 */
function aplicarAlItemEnCurso(estado: EstadoEmision, aplicar: (item: ItemEnCurso) => void): void {
  const items = [...(estado.items ?? [])];
  const ultimo = items.length === 0 ? undefined : { ...items[items.length - 1]! };
  const item = ultimo ?? {};
  aplicar(item);
  if (ultimo === undefined) items.push(item);
  else items[items.length - 1] = item;
  estado.items = items;
}

/**
 * Convierte los `precio`/`cantidad` que llegaron como texto a números.
 *
 * Un ítem cuyo precio no se puede leer queda SIN precio, no con un precio
 * inventado: el flujo vuelve a preguntarlo, que es exactamente lo que hay que
 * hacer. Devolver 0, o `NaN`, o el número más parecido, sería tapar el problema
 * en el único lugar donde todavía se puede resolver preguntando.
 */
function normalizarItems(
  items: ReadonlyArray<{
    concepto?: string;
    cantidad?: number | string;
    precio?: number | string;
    indicador_facturacion?: number;
  }> | undefined,
): { items: ItemEnCurso[] | undefined; warnings: string[] } {
  if (items === undefined) return { items: undefined, warnings: [] };
  const warnings: string[] = [];

  const out = items.map((item, i) => {
    const ordinal = items.length === 1 ? "" : ` (ítem ${i + 1})`;
    const salida: ItemEnCurso = {
      ...(item.concepto !== undefined ? { concepto: item.concepto } : {}),
      ...(item.indicador_facturacion !== undefined
        ? { indicador_facturacion: item.indicador_facturacion }
        : {}),
    };

    if (typeof item.precio === "number") {
      salida.precio = item.precio;
    } else if (typeof item.precio === "string") {
      const leido = parsearImporte(item.precio);
      if (leido.valor === null) {
        warnings.push(`No se pudo leer el precio "${item.precio}"${ordinal}: ${leido.detalle}`);
      } else {
        salida.precio = leido.valor;
        if (leido.ambiguo) {
          warnings.push(
            `⚠️ El precio "${item.precio}"${ordinal} se puede leer de dos formas. ${leido.detalle} ` +
              `Preguntale al usuario "¿$${formatearUy(leido.valor)} por unidad?" y esperá que lo ` +
              "confirme ANTES de emitir.",
          );
        }
      }
    }

    if (typeof item.cantidad === "number") {
      salida.cantidad = item.cantidad;
    } else if (typeof item.cantidad === "string") {
      const leida = parsearCantidad(item.cantidad);
      if (leida.valor === null) {
        warnings.push(`No se pudo leer la cantidad "${item.cantidad}"${ordinal}: ${leida.detalle}`);
      } else {
        salida.cantidad = leida.valor;
      }
    }

    return salida;
  });

  return { items: out, warnings };
}

export async function handleEmisionGuiada(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return simpleErrorResult(`Parámetros inválidos: ${parsed.error.issues[0]?.message ?? ""}`, ctx);
  }
  const a = parsed.data;

  if (a.enviar && (a.destinatario === undefined || a.destinatario.trim() === "")) {
    return simpleErrorResult(
      "Para enviar el paso hace falta 'destinatario' (número de WhatsApp en formato internacional).",
      ctx,
    );
  }

  try {
    const warnings: string[] = [];

    // --- Los números, leídos por TypeScript y no por el modelo ---------------
    //
    // `precio` y `cantidad` pueden venir como texto ("6.500"). Se convierten
    // acá, con las reglas de `services/importe.ts`, y lo que quede ambiguo se
    // devuelve como warning para que se confirme ANTES de emitir. Es la
    // diferencia entre facturar seis mil quinientos y facturar seis con
    // cincuenta.
    const { items: itemsNormalizados, warnings: warningsImportes } = normalizarItems(a.items);
    warnings.push(...warningsImportes);

    // La tasa de cambio también la escribe una persona ("40", "40,5"): mismo
    // parser que los precios, por el mismo motivo.
    let tasaCambio: number | undefined;
    if (typeof a.tasa_cambio === "number") {
      tasaCambio = a.tasa_cambio;
    } else if (typeof a.tasa_cambio === "string") {
      const leida = parsearImporte(a.tasa_cambio);
      if (leida.valor === null) warnings.push(`No se pudo leer la tasa de cambio "${a.tasa_cambio}".`);
      else tasaCambio = leida.valor;
    }

    // --- Estado: lo que vino explícito + lo que se deduce del mensaje --------
    // Los campos que se copian TAL CUAL del input al estado. Es una lista y no
    // dieciséis spreads condicionales porque agregar un campo a EstadoEmision
    // ya exige tocar varios lugares (el schema, `resumirEstado`,
    // `borradorComprobante`) — y cada enumeración manual de más es otra chance
    // de que el campo nuevo se copie en cuatro lados y falte en el quinto sin
    // que falle nada. Los tres que NO están acá se transforman antes de entrar:
    // `items` (parseo de importes), `moneda` (mayúsculas), `tasa_cambio` (parseo).
    const CAMPOS_DIRECTOS = [
      "clase_receptor",
      "fecha_emision",
      "documento",
      "nombre_cliente",
      "sin_receptor",
      "cliente_ya_facturado",
      "direccion_cliente",
      "ciudad_cliente",
      "items_cerrados",
      "indicador_facturacion",
      "montos_brutos",
      "fecha_vencimiento",
      "forma_pago",
      "adenda",
      "sin_adenda",
    ] as const satisfies ReadonlyArray<keyof EstadoEmision>;

    const estadoArgs: EstadoEmision = {};
    for (const campo of CAMPOS_DIRECTOS) {
      const valor = a[campo];
      if (valor !== undefined) (estadoArgs as Record<string, unknown>)[campo] = valor;
    }
    if (a.items !== undefined) estadoArgs.items = itemsNormalizados;
    if (a.moneda !== undefined) estadoArgs.moneda = a.moneda.toUpperCase();
    if (tasaCambio !== undefined) estadoArgs.tasa_cambio = tasaCambio;

    // "Rivera 1234, Melo" son DOS campos en un mensaje. Se parten acá, con las
    // reglas escritas de `separarDireccionCiudad`, y no en el prompt del
    // modelo: partir por la coma equivocada le pone "apto 302" de ciudad a un
    // cliente que queda dado de alta así para siempre.
    if (estadoArgs.direccion_cliente !== undefined && estadoArgs.ciudad_cliente === undefined) {
      const partido = separarDireccionCiudad(estadoArgs.direccion_cliente);
      estadoArgs.direccion_cliente = partido.direccion;
      if (partido.ciudad !== undefined) estadoArgs.ciudad_cliente = partido.ciudad;
    }

    // ¿EL TEXTO HABLÓ DE DÓLARES?
    //
    // La moneda tiene default UYU, y el default solo es defendible si algo mira
    // el mensaje. Lo mira acá —la tool, que es la que ve texto libre— y no
    // `siguientePaso`, que es pura y no lee castellano. Ver `moneda_dudosa`.
    if (
      a.mensaje !== undefined &&
      !a.mensaje.trim().startsWith(PREFIJO_PASO) &&
      a.moneda === undefined &&
      sugiereDolares(a.mensaje)
    ) {
      estadoArgs.moneda_dudosa = true;
    }

    // --- El store: lo que ya sabíamos va DEBAJO de lo que llegó ahora --------
    //
    // Este es el cambio que saca al flujo de emisión de encima del contexto del
    // modelo. Antes el contrato era "mandá TODO lo que sabés en cada llamada", y
    // un agente que se olvidaba de un campo hacía que se lo volvieran a
    // preguntar al usuario. Ahora lo guardado es la base y lo que llega es el
    // overlay: mandar de más sigue funcionando igual, y mandar de menos ya no
    // pierde nada.
    //
    // El orden importa y no es intercambiable: primero se fusiona con lo
    // guardado, y RECIÉN DESPUÉS se aplica el id del botón. El botón es lo
    // último que hizo el usuario, así que tiene que ganarle tanto a lo guardado
    // como a lo que el agente creía saber.
    const store = ctx.getBorradorStore();
    const clave = a.sesion === undefined || a.sesion.trim() === "" ? null : resolverClaveSesion(a.sesion);
    if (clave !== null && a.reiniciar) store.borrar(clave);

    const guardado = clave === null ? null : store.leer(clave);
    const estado: EstadoEmision =
      guardado === null ? estadoArgs : fusionarEstado(guardado.estado, estadoArgs);

    // --- "Lo de siempre" (V5.1): prellenar desde la última venta -------------
    //
    // Solo cuando NO hay borrador en curso: si ya se está cargando una factura,
    // pisarla con la de la semana pasada sería perder trabajo hecho. El que
    // quiere empezar de nuevo tiene `reiniciar`.
    let repeticion: ResultadoRepeticion | null = null;
    if (a.repetir_ultima_de !== undefined && clave !== null && guardado === null) {
      repeticion = await prellenarDesdeUltimaVenta(ctx, a.repetir_ultima_de, estado);
      warnings.push(...(repeticion?.advertencias ?? []));
    } else if (a.repetir_ultima_de !== undefined && clave === null) {
      warnings.push("repetir_ultima_de necesita 'sesion': los conceptos copiados viven en el borrador del server.");
    } else if (a.repetir_ultima_de !== undefined && guardado !== null) {
      warnings.push(
        "Ya hay un borrador en curso en esta sesión: no se pisó con la factura anterior. " +
          "Si el usuario quiere empezar de nuevo con lo de siempre, mandá reiniciar=true junto con repetir_ultima_de.",
      );
    }

    // El numero_interno nace CON el borrador y no cambia más. Ver EstadoEmision.
    //
    // La parte aleatoria NO compromete la idempotencia — al revés: la
    // estabilidad viene de que el id se genera UNA vez y queda guardado en el
    // borrador, así que un reintento de la misma emisión repite el id (y la
    // deduplicación de la API lo frena). Lo aleatorio solo garantiza que dos
    // borradores distintos —incluso creados en el mismo milisegundo— no
    // compartan id, que con un timestamp no estaba garantizado.
    if (clave !== null && estado.numero_interno === undefined) {
      estado.numero_interno = `wa-${clave.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    }

    // Un id de botón de este flujo pisa lo que haya: es lo último que hizo el
    // usuario, y es un dato explícito, no una inferencia.
    let pidioDesempate = false;
    let pidioOtroCliente = false;
    let pidioOtraFecha = false;
    let pidioOtraTasa = false;
    if (a.mensaje !== undefined) {
      const r = interpretarPaso(a.mensaje);
      switch (r.paso) {
        case "receptor":
          estado.clase_receptor = r.clase;
          break;
        case "receptor_no_se":
          pidioDesempate = true;
          break;
        case "cliente":
          estado.documento = r.documento;
          break;
        case "cliente_otro":
          pidioOtroCliente = true;
          break;
        case "cliente_sin_identificar":
          estado.sin_receptor = true;
          break;
        case "fecha_hoy":
          estado.fecha_emision = hoyDgi();
          break;
        case "fecha_otra":
          // Tocó "otra fecha": no hay dato todavía, solo la intención. El paso
          // sigue siendo "fecha", pero preguntado como texto libre.
          pidioOtraFecha = true;
          break;
        case "cantidad":
          aplicarAlItemEnCurso(estado, (item) => (item.cantidad = r.cantidad));
          break;
        case "item_otro":
          // Abrir un ítem vacío ES la forma de decir "seguí preguntando por
          // otro": `siguientePaso` mira siempre el último del array. Llega
          // tanto del flujo como del botón ➕ del preview de confirmación.
          estado.items = [...(estado.items ?? []), {}];
          estado.items_cerrados = false;
          break;
        case "item_listo":
          estado.items_cerrados = true;
          break;
        case "item_cancelar":
          // "↩️ Volver así": se descarta el ítem vacío que se abrió por error y
          // el flujo vuelve al preview. Solo se saca si está VACÍO — un ítem a
          // medio cargar es trabajo del usuario, no basura.
          if ((estado.items ?? []).length > 1) {
            const ultimo = estado.items![estado.items!.length - 1]!;
            if (Object.keys(ultimo).length === 0) estado.items = estado.items!.slice(0, -1);
          }
          estado.items_cerrados = true;
          break;
        case "iva":
          estado.indicador_facturacion = r.indicador_facturacion;
          break;
        case "iva_otro":
          // "🔢 Otro IVA" no contesta nada: abre la pregunta de la tasa. El
          // criterio de precio (montos_brutos) queda pendiente y se pregunta
          // después, ya con dos botones.
          pidioOtraTasa = true;
          break;
        case "moneda":
          estado.moneda = r.moneda;
          // Elegida la moneda, la duda dejó de existir. Sin esto la marca queda
          // guardada en el borrador y reaparece si alguien limpia `moneda`.
          delete estado.moneda_dudosa;
          break;
        case "forma_pago":
          estado.forma_pago = r.forma_pago;
          break;
        case "montos_brutos":
          estado.montos_brutos = r.incluye_iva;
          // LOS DOS BOTONES GRANDES CONTESTAN LAS DOS COSAS.
          //
          // El paso fusionado dice, en el mismo mensaje, "tomo tasa básica
          // salvo que me digas otra cosa". Si el indicador no se fijara acá, el
          // usuario tocaría "✅ Ya incluye IVA" y le volveríamos a preguntar la
          // tasa — o sea, la fusión no ahorraría nada. Solo COMPLETA: un
          // indicador que ya venía (de `repetir_ultima_de`, o del botón "Otro
          // IVA") no se pisa.
          estado.indicador_facturacion ??= 3;
          break;
        case "ninguna":
          break;
      }
    }

    // Qué sobrevivió gracias al store y no vino en esta llamada. Se calcula
    // DESPUÉS del botón: un campo que el botón acaba de fijar es "lo que el
    // usuario hizo recién", no algo recuperado — calcularlo antes lo listaba
    // igual. Se devuelven NOMBRES DE CAMPO, nunca valores: la respuesta sigue
    // sin sacar del server el concepto ni la adenda (ver `borradorComprobante`).
    const recuperado =
      guardado === null
        ? []
        : Object.keys(guardado.estado).filter(
            (k) =>
              (estadoArgs as Record<string, unknown>)[k] === undefined &&
              JSON.stringify((estado as Record<string, unknown>)[k]) ===
                JSON.stringify((guardado.estado as Record<string, unknown>)[k]),
          );

    // --- El documento decide la clase de receptor ---------------------------
    let documentoDetectado = null as ReturnType<typeof clasificarDocumento> | null;
    if (estado.documento !== undefined && estado.documento.trim() !== "") {
      documentoDetectado = clasificarDocumento(estado.documento);
      if (documentoDetectado.clase !== null) {
        // El documento GANA sobre lo que se haya dicho antes: si alguien dijo
        // "consumidor final" y después pasó un RUT de 12 dígitos, el RUT es el
        // dato duro y la etiqueta era una suposición.
        if (estado.clase_receptor !== undefined && estado.clase_receptor !== documentoDetectado.clase) {
          warnings.push(
            `Se había dicho "${estado.clase_receptor}" pero el documento ${documentoDetectado.normalizado} ` +
              `es ${documentoDetectado.tipo === "rut" ? "un RUT" : "una cédula"}. Vale el documento: ` +
              `el receptor es ${documentoDetectado.clase === "empresa" ? "una empresa" : "un consumidor final"}.`,
          );
        }
        estado.clase_receptor = documentoDetectado.clase;
      } else {
        warnings.push(documentoDetectado.detalle);
        delete estado.documento;
      }
    }

    // --- Qué sigue -----------------------------------------------------------
    let siguiente = siguientePaso(estado);

    // "✏️ Otra fecha" es la única respuesta que RETROCEDE el flujo: el usuario
    // descartó un dato que ya estaba resuelto (hoy, por default) y todavía no
    // dio el reemplazo. Sin este override, `siguientePaso` devolvería
    // "confirmar" con `listo: true` mientras le preguntamos la fecha — o sea,
    // le diríamos al agente "andá a emitir" en medio de una pregunta.
    if (pidioOtraFecha) {
      siguiente = { ...siguiente, paso: "fecha", listo: false };
    }

    const tipo =
      siguiente.tipo ??
      (estado.clase_receptor === undefined
        ? null
        : tipoComprobanteSugerido(estado.clase_receptor as ClaseReceptor));

    // El desempate y la lista de clientes son mensajes de este paso, no pasos
    // nuevos: cambian QUÉ se manda, no en qué punto del flujo se está.
    let interactivo = siguiente.interactivo;
    let pregunta = siguiente.pregunta;
    if (pidioDesempate) {
      interactivo = construirDesempateReceptor();
      pregunta = "¿Te pidieron la factura a nombre de una empresa con RUT?";
    } else if (pidioOtraFecha) {
      // Ya eligió "otra fecha": volver a mostrarle el botón "Hoy" sería
      // ofrecerle justo lo que acaba de descartar. No se condiciona al paso —
      // desde que la fecha tiene default, `siguientePaso` NUNCA devuelve "fecha"
      // y la condición vieja hacía que este botón dejara de contestar nada.
      interactivo = null;
      pregunta = "Dale, ¿qué fecha? Escribímela como dd/mm/aaaa.";
    } else if (pidioOtraTasa) {
      // "🔢 Otro IVA": el paso sigue siendo el mismo (el IVA está sin resolver),
      // cambia el mensaje — de los tres botones fusionados a las tres tasas.
      interactivo = construirSubmenuIva();
      pregunta = "¿Qué IVA lleva? Tasa básica (22%), mínima (10%) o exento.";
    } else if (
      siguiente.paso === "cliente" &&
      !pidioOtroCliente &&
      a.clientes_frecuentes !== undefined &&
      a.clientes_frecuentes.length > 0
    ) {
      const lista = construirListaClientes(a.clientes_frecuentes);
      return await responder({
        a,
        ctx,
        estado,
        siguiente,
        tipo,
        pregunta: "Elegí el cliente de la lista, o mandame el RUT.",
        interactivo: lista,
        documentoDetectado,
        warnings,
        sesion: { store, clave, recuperado },
      });
    }

    return await responder({
      a,
      ctx,
      estado,
      siguiente,
      tipo,
      pregunta,
      interactivo,
      documentoDetectado,
      warnings,
      sesion: { store, clave, recuperado },
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

/**
 * Arma el borrador con la forma que espera `biller_emitir_comprobante`.
 *
 * DELIBERADAMENTE NO INCLUYE `concepto` NI `razon_social`, y no es un descuido:
 *
 * Esos dos nombres de clave están en `CAMPOS_NO_CONFIABLES`, así que la barrera
 * de salida los envuelve en ⟦dato-no-confiable⟧ antes de que salgan del server.
 * Para el texto de un comprobante RECIBIDO eso es exactamente lo correcto. Pero
 * un borrador que vuelve envuelto es peor que inútil: si el agente lo pasa tal
 * cual a la emisión, las marcas terminan impresas en el CFE.
 *
 * La salida no es debilitar la barrera —compara por nombre de clave a propósito,
 * y una excepción acá es la grieta por la que después pasa texto de un tercero—.
 * Es notar que esos dos campos no tienen por qué estar acá: el borrador existe
 * para cargar lo que la tool DEDUJO (el tipo de CFE, el indicador de IVA, la
 * forma de pago), que es justo donde un modelo se equivoca caro. El concepto y
 * la razón social los escribió el usuario hace dos mensajes y el agente los
 * tiene textuales; copiarlos es lo único que sabe hacer sin equivocarse.
 *
 * Por eso el borrador viene acompañado de `completar`: qué falta agregarle y de
 * dónde sacarlo. Ver `menuWhatsapp.ts` para el mismo problema resuelto al revés
 * (ahí se pudo renombrar la clave; acá la clave es parte del contrato de la API).
 */
function borradorComprobante(
  estado: EstadoEmision,
  tipo: number | null,
): { borrador: Record<string, unknown>; completar: string[] } {
  const borrador: Record<string, unknown> = {};
  const completar: string[] = [];

  if (tipo !== null) borrador["tipo_comprobante"] = tipo;
  // La defensa contra emitir dos veces por un retry. Generado por el server; el
  // agente solo lo copia, como todo lo demás del borrador.
  if (estado.numero_interno !== undefined) borrador["numero_interno"] = estado.numero_interno;
  if (estado.fecha_emision !== undefined) borrador["fecha_emision"] = estado.fecha_emision;
  if (estado.forma_pago !== undefined) borrador["forma_pago"] = estado.forma_pago;
  if (estado.moneda !== undefined) borrador["moneda"] = estado.moneda;
  if (estado.tasa_cambio !== undefined) borrador["tasa_cambio"] = estado.tasa_cambio;
  if (estado.fecha_vencimiento !== undefined) {
    borrador["fecha_vencimiento"] = estado.fecha_vencimiento;
  }
  // `montos_brutos` va SIEMPRE que se sepa, incluso en false.
  //
  // Omitirlo no es neutral: la API interpreta la ausencia como "los precios son
  // netos" y le suma el IVA. O sea que el silencio ya es una respuesta, y es la
  // equivocada para el precio de mostrador uruguayo, que se cotiza con IVA
  // adentro. Un borrador que no lleva el campo factura 22% de más.
  if (estado.montos_brutos !== undefined) borrador["montos_brutos"] = estado.montos_brutos;

  if (estado.documento !== undefined) {
    const d = clasificarDocumento(estado.documento);
    if (d.tipo !== "desconocido") {
      // `tipo_documento` YA está deducido (12 dígitos = RUT, 7-8 = CI): dejarlo
      // afuera obligaba al modelo a re-deducirlo, y ese código decide en qué
      // CAMPO va el nombre del cliente. Ver el `completar` de acá abajo.
      const cliente: Record<string, unknown> = {
        tipo_documento: d.tipo === "rut" ? 2 : 3,
        documento: d.normalizado,
      };

      // `cliente.sucursal.pais` es obligatorio para clientes que no son
      // empresas, así que va SIEMPRE y no solo cuando el cliente es nuevo.
      const sucursal: Record<string, unknown> = { pais: "UY" };
      if (estado.cliente_ya_facturado === false) {
        // Dirección y ciudad solo cuando hay que darlo de alta: son los dos
        // campos que la API exige en esa llamada (verificado: 422 sin ellos).
        if (estado.direccion_cliente !== undefined) sucursal["direccion"] = estado.direccion_cliente;
        if (estado.ciudad_cliente !== undefined) sucursal["ciudad"] = estado.ciudad_cliente;
      }
      cliente["sucursal"] = sucursal;
      borrador["cliente"] = cliente;
    }
  }
  if (estado.nombre_cliente !== undefined && estado.nombre_cliente.trim() !== "") {
    // EL CAMPO DEPENDE DEL TIPO DE DOCUMENTO, y no es intercambiable: con RUT
    // el nombre principal es `razon_social`; con cédula es `nombre_fantasia`.
    // Antes esto decía siempre "razon_social", así que a un consumidor final
    // identificado con CI se le mandaba el nombre en el campo equivocado.
    const d = estado.documento === undefined ? null : clasificarDocumento(estado.documento);
    const campo = d?.tipo === "ci" ? "cliente.nombre_fantasia" : "cliente.razon_social";
    const porque =
      d?.tipo === "ci"
        ? "es una cédula (tipo_documento 3), y para 3/5/6 el nombre principal va en nombre_fantasia"
        : "es un RUT (tipo_documento 2), y para 2/7 el nombre principal va en razon_social";
    completar.push(
      `${campo}: ponelo vos, con el nombre que te dio el usuario en la conversación — ${porque}. ` +
        "(No lo devuelvo acá para no ensuciarlo con las marcas de la barrera de salida.)",
    );
  }

  const items = (estado.items ?? [])
    // Un ítem a medio cargar no va al borrador: mandar precio sin concepto
    // produce un 422 que habla de un campo que el usuario nunca vio.
    .filter((i) => (i.concepto ?? "") !== "" && typeof i.precio === "number")
    .map((i) => {
      const item: Record<string, unknown> = {};
      if (i.cantidad !== undefined) item["cantidad"] = i.cantidad;
      if (i.precio !== undefined) item["precio"] = i.precio;
      const ind = i.indicador_facturacion ?? estado.indicador_facturacion;
      if (ind !== undefined) item["indicador_facturacion"] = ind;
      return item;
    });
  if (items.length > 0) {
    borrador["items"] = items;
    completar.push(
      "items[].concepto: completá cada ítem con la descripción TEXTUAL que dio el usuario, en el " +
        "mismo orden en que la dijo. Es el único campo del cuerpo que sale de la conversación.",
    );
  }

  // `adenda` está en CAMPOS_NO_CONFIABLES igual que `concepto`: si volviera acá
  // volvería envuelta, y esas marcas terminarían impresas en el CFE.
  if (estado.adenda !== undefined && estado.adenda.trim() !== "") {
    completar.push(
      "adenda: ponela vos, con las palabras textuales del usuario (no la devuelvo acá por la " +
        "barrera de salida).",
    );
  }

  return { borrador, completar };
}

/**
 * Lo que la tool ENTENDIÓ, para que el agente lo lea — no para que lo reinyecte.
 *
 * Se llama `estado_entendido` y no `estado` a propósito: un campo llamado
 * "estado" invita a pasarlo de vuelta como entrada en la próxima llamada, y eso
 * acá es un lazo infinito. El concepto de cada ítem no puede volver en la
 * salida (la barrera lo envuelve, ver `borradorComprobante`), así que un estado
 * reinyectado llegaría sin conceptos, `siguientePaso` diría "faltan los ítems",
 * y el flujo preguntaría lo mismo para siempre.
 *
 * El contrato es el otro: el agente manda TODO lo que sabe en cada llamada, y
 * lo que sabe está en la conversación, que es de donde salió. Esto es un
 * espejo para que pueda verificar que se entendió bien, y nada más.
 */
function resumirEstado(estado: EstadoEmision): Record<string, unknown> {
  const resumen: Record<string, unknown> = {};
  if (estado.clase_receptor !== undefined) resumen["clase_receptor"] = estado.clase_receptor;
  if (estado.fecha_emision !== undefined) resumen["fecha_emision"] = estado.fecha_emision;
  if (estado.documento !== undefined) resumen["documento"] = estado.documento;
  if (estado.nombre_cliente !== undefined) resumen["nombre_cliente"] = estado.nombre_cliente;
  if (estado.sin_receptor !== undefined) resumen["sin_receptor"] = estado.sin_receptor;
  if (estado.cliente_ya_facturado !== undefined) {
    resumen["cliente_ya_facturado"] = estado.cliente_ya_facturado;
  }
  if (estado.indicador_facturacion !== undefined) {
    resumen["indicador_facturacion"] = estado.indicador_facturacion;
  }
  if (estado.moneda !== undefined) resumen["moneda"] = estado.moneda;
  if (estado.forma_pago !== undefined) resumen["forma_pago"] = estado.forma_pago;
  if (estado.items_cerrados !== undefined) resumen["items_cerrados"] = estado.items_cerrados;
  // El texto de la adenda NO vuelve (barrera de salida); vuelve si está o no.
  if (estado.adenda !== undefined) resumen["adenda_cargada"] = estado.adenda.trim() !== "";
  if (estado.sin_adenda !== undefined) resumen["sin_adenda"] = estado.sin_adenda;
  if (estado.numero_interno !== undefined) resumen["numero_interno"] = estado.numero_interno;

  if (estado.items !== undefined) {
    resumen["items"] = estado.items.map((i) => ({
      // El texto NO vuelve; vuelve si estaba o no. Ver el comentario de arriba.
      concepto_cargado: (i.concepto ?? "") !== "",
      ...(i.cantidad !== undefined ? { cantidad: i.cantidad } : {}),
      ...(i.precio !== undefined ? { precio: i.precio } : {}),
      ...(i.indicador_facturacion !== undefined
        ? { indicador_facturacion: i.indicador_facturacion }
        : {}),
    }));
  }
  return resumen;
}

/** Camino único de salida: arma la respuesta y, si corresponde, manda el mensaje. */
async function responder(p: {
  a: z.infer<typeof inputSchema>;
  ctx: ToolContext;
  estado: EstadoEmision;
  siguiente: ReturnType<typeof siguientePaso>;
  tipo: ReturnType<typeof tipoComprobanteSugerido> | null;
  pregunta: string;
  interactivo: Parameters<KapsoClient["enviarInteractivo"]>[1] | null;
  documentoDetectado: ReturnType<typeof clasificarDocumento> | null;
  warnings: string[];
  sesion: { store: BorradorStore; clave: string | null; recuperado: string[] };
}): Promise<ToolResult> {
  const { a, ctx, estado, siguiente, tipo, pregunta, interactivo, documentoDetectado } = p;
  const warnings = [...p.warnings];
  const config = ctx.getConfig();

  if (config.capabilityMode !== "write_enabled") {
    warnings.push(
      "El server está en modo consulta (BILLER_CAPABILITY_MODE=read_only): puedo guiar la carga " +
        "pero biller_emitir_comprobante NO está registrada, así que este flujo no va a poder " +
        "terminar en una emisión. Decíselo al usuario ANTES de pedirle todos los datos.",
    );
  }

  // --- Guardar PRIMERO, mandar después ---------------------------------------
  //
  // El orden importa: `enviarInteractivo` puede tirar (Kapso caído, token
  // vencido), y si el guardado viniera después, la excepción se llevaría
  // puesta la respuesta que el usuario ACABA de dar — el dato más nuevo del
  // borrador, perdido justo por un problema que no tiene nada que ver con él.
  // Guardado primero, lo peor que hace una falla de Kapso es no mandar un
  // mensaje; el estado ya quedó.
  //
  // Se guarda SIEMPRE que haya sesión, incluso en el último paso: el borrador
  // se borra cuando el comprobante se emite, no cuando el flujo termina de
  // preguntar. Entre "ya tengo todo" y el CFE falta el ciclo de confirmación
  // entero, que es justo donde el usuario se va a hacer otra cosa y vuelve
  // diez minutos después.
  const { store, clave, recuperado } = p.sesion;
  let revision: number | null = null;
  if (clave !== null) revision = store.guardar(clave, estado).revision;

  let realizado = false;
  let motivo: string | null = null;
  let messageId: string | null = null;
  let sufijo: string | null = null;

  if (!a.enviar) {
    motivo = "No se solicitó envío (enviar=false).";
  } else if (interactivo === null) {
    motivo =
      "Este paso es de texto libre (no tiene botones): contestalo vos con 'pregunta', no hace " +
      "falta un mensaje interactivo.";
  } else if (config.kapso === undefined) {
    motivo = "Kapso no está configurado: falta KAPSO_API_KEY.";
    warnings.push(motivo);
  } else {
    const destino = normalizarTelefono(a.destinatario!);
    sufijo = destino.slice(-4);
    const kapso = new KapsoClient(config.kapso);
    const resultado = await kapso.enviarInteractivo(destino, interactivo);
    realizado = true;
    messageId = resultado.message_id;
  }

  // EL BORRADOR SALE CON LOS DEFAULTS PUESTOS; EL BORRADOR GUARDADO, NO.
  //
  // Los dos lados de la misma decisión. Lo que se GUARDA es lo que dijo el
  // usuario, así que `forma_pago: undefined` sigue significando "no me dijeron
  // nada" y una corrección posterior lo pisa sin discutir (ver
  // `aplicarDefaults`). Lo que SALE hacia el CFE tiene que estar completo: un
  // comprobante sin `fecha_emision` no se emite, y un `montos_brutos` ausente
  // factura 22% de más.
  const { estado: conDefaults, aplicados } = aplicarDefaults(estado);
  const { borrador, completar } = borradorComprobante(conDefaults, tipo?.tipo_comprobante ?? null);

  const notaSesion =
    clave === null
      ? "Sin sesión: el estado NO se guardó y en la próxima llamada tenés que volver a mandar todo. " +
        "Si hay una conversación de WhatsApp, pasá 'sesion' con el número y te lo guardo yo."
      : recuperado.length === 0
        ? "Borrador guardado. En la próxima llamada alcanza con el dato nuevo."
        : `Borrador guardado. Se recuperaron del store ${recuperado.length} campo(s) que no venían ` +
          `en esta llamada (${recuperado.join(", ")}): sin sesión, esos datos se habrían vuelto a ` +
          "preguntar.";

  // EL EMBUDO DE LA EMISIÓN.
  //
  // Cada invocación cuenta en qué paso quedó. Sumadas, dan la curva que
  // contesta la pregunta que hoy nadie puede contestar: si 100 conversaciones
  // llegan al paso "cliente" y 12 al paso "confirmar", se están abandonando 88
  // emisiones y sabemos EXACTAMENTE en qué pregunta se caen.
  //
  // No hace falta un id de sesión para esto —que sería un dato más que
  // guardar—: la forma del embudo se ve igual contando pasos sueltos.
  ctx.metricas.contar("emision.paso", {
    paso: siguiente.paso,
    listo: siguiente.listo ? "si" : "no",
    // Con o sin store. Es lo que va a decir si el store sirvió: si el abandono
    // por paso baja en las conversaciones con sesión, la hipótesis era cierta.
    sesion: clave === null ? "no" : "si",
  });

  return jsonResult({
    paso: siguiente.paso,
    pregunta,
    listo_para_requisitos: siguiente.listo,
    tipo_comprobante: tipo?.tipo_comprobante ?? null,
    tipo_etiqueta: tipo?.etiqueta ?? null,
    tipo_motivo: tipo?.motivo ?? null,
    // El espejo muestra el estado YA RESUELTO, que es el comprobante que se va
    // a emitir. `defaults_aplicados` dice cuáles de esos valores los puso el
    // sistema y no el usuario: sin esa lista, el agente no tiene cómo
    // distinguir "dijo contado" de "no dijo nada" y no puede avisarlo.
    estado_entendido: resumirEstado(conDefaults),
    defaults_aplicados: aplicados,
    comprobante_borrador: borrador,
    completar,
    documento_detectado: documentoDetectado,
    sesion: {
      activa: clave !== null,
      id: clave,
      revision,
      recuperado_del_store: recuperado,
      nota: notaSesion,
    },
    como_sigue: siguiente.listo
      ? "Ya está todo. Pasá 'comprobante_borrador' a biller_requisitos_comprobante para el chequeo " +
        "final (umbral de UI, campos de DGI) y después a biller_emitir_comprobante SIN confirm, con " +
        "confirmar_por_whatsapp = el número de la conversación. Eso manda los botones ✅/✖️."
      : `Falta el paso "${siguiente.paso}". Hacé SOLO esa pregunta (está en 'pregunta'), y volvé a ` +
        "llamar esta tool con la respuesta sumada a lo que ya pasaste. No pidas varios datos juntos.",
    envio: {
      solicitado: a.enviar,
      realizado,
      motivo,
      destinatario_sufijo: sufijo,
      message_id: messageId,
    },
    warnings,
  });
}

/**
 * Busca la última venta aceptada del cliente y la vuelca SOBRE el estado.
 *
 * "Sobre" importa: lo que el usuario dijo en ESTE mensaje le gana a lo copiado.
 * "Facturale lo de siempre a Pérez pero 3 bolsas" copia todo y pisa la cantidad.
 *
 * Devuelve null (con advertencia) si no hay qué copiar; el flujo sigue de cero,
 * que es exactamente lo que pasaba antes de que esta función existiera.
 */
async function prellenarDesdeUltimaVenta(
  ctx: ToolContext,
  documento: string,
  estado: EstadoEmision,
): Promise<ResultadoRepeticion | null> {
  const client = ctx.getClient();
  // Anclado al día uruguayo: con el instante crudo, después de las 21:00 la
  // ventana de 180 días arrancaba (y terminaba) un día corrida.
  const hoy = hoyComoDateUy();
  const desde = aIso(new Date(hoy.getTime() - 180 * 86_400_000));
  const hasta = hoyIsoUy(hoy);

  const consulta = await consultarPorPeriodo(client, { desde, hasta }, {});
  const rut = documento.replace(/\D/g, "");
  const delCliente = consulta.comprobantes.filter((c) => extractClienteRut(c.cliente) === rut);
  const elegido = elegirComprobanteARepetir(delCliente);
  if (elegido === null || elegido.id === null) {
    return {
      estado: {},
      copiado_de_id: null,
      copiado_de_fecha: null,
      items_copiados: 0,
      advertencias: [
        `No encontré ninguna venta aceptada de ese cliente en los últimos 180 días: no hay "lo de ` +
          'siempre" que copiar. El flujo arranca de cero.',
      ],
    };
  }

  // El listado no trae ítems: hay que pedir el detalle por id.
  const detalle = (await fetchEmitidos(client, { id: String(elegido.id) }))[0];
  if (detalle === undefined) {
    return {
      estado: {},
      copiado_de_id: elegido.id,
      copiado_de_fecha: null,
      items_copiados: 0,
      advertencias: ["Se encontró la venta anterior pero no se pudo leer su detalle. El flujo arranca de cero."],
    };
  }

  const r = estadoDesdeComprobante(detalle);
  // Copiado DEBAJO de lo dicho: fusionar con el estado actual encima.
  const fusionado = fusionarEstado(r.estado, estado);
  for (const clave of Object.keys(estado) as Array<keyof EstadoEmision>) delete (estado as Record<string, unknown>)[clave];
  Object.assign(estado, fusionado);
  return r;
}

export function registerEmisionGuiada(server: McpServer, ctx: ToolContext): void {
  const puedeEnviar = (() => {
    try {
      return ctx.getConfig().kapso !== undefined;
    } catch {
      return false;
    }
  })();

  server.registerTool(
    "biller_emision_guiada",
    {
      title: "Emisión guiada por WhatsApp",
      description:
        "El PRIMER paso para emitir un comprobante desde un chat. Preguntá con esto en vez de " +
        'pedirle a alguien que elija entre "101" y "111": la tool pregunta a QUIÉN se le factura ' +
        "(empresa con RUT o consumidor final), DEDUCE de ahí el tipo de CFE, y va devolviendo una " +
        "sola pregunta por vez con el mensaje tocable ya armado. Detecta si un documento es RUT o " +
        "cédula y corrige la clase de receptor en consecuencia. " +
        "PREGUNTA POCO A PROPÓSITO: la fecha (hoy), la moneda (UYU), la forma de pago (contado) y la " +
        "cantidad (1) se completan solas y aparecen en el preview de confirmación — no las mandes " +
        "salvo que el usuario las haya dicho, y no se las preguntes vos por tu cuenta. " +
        "Devuelve 'comprobante_borrador' con la forma exacta que espera biller_emitir_comprobante " +
        "y 'defaults_aplicados' con lo que se completó solo. No emite nada.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: puedeEnviar
        ? { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Emisión guiada" }
        : { ...READ_ONLY_ANNOTATIONS, title: "Emisión guiada" },
    },
    async (args) => handleEmisionGuiada(args, ctx),
  );
}
