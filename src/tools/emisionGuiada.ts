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
// EL PERFIL DE LA CASA
//
// Después de sacar cinco preguntas del flujo quedaba una que se hacía casi
// siempre: si el precio ya trae el IVA adentro. No se puede adivinar del
// mensaje —los dos valores están bien para mitad del mundo cada uno— pero sí
// está escrito en las últimas facturas de la empresa, que no cambian de
// criterio entre una y otra. Esta tool las lee (`buscarPerfilCasa` →
// `derivarPerfilCasa`) y usa lo que encuentre como una capa de defaults que va
// DEBAJO de todo lo demás y ARRIBA de los defaults duros. Solo defaultea el
// criterio de IVA cuando los últimos cinco CFE aceptados coinciden TODOS: si
// hay mezcla, se pregunta como siempre.
//
// Devuelve además `comprobante_borrador`: el cuerpo parcial con la forma exacta
// que espera `biller_emitir_comprobante`. Eso saca del modelo la tarea de armar
// el payload campo por campo, que es donde se cuelan los errores caros (un
// `indicador_facturacion` inventado es un CFE con el IVA mal).
//
// NO EMITE NADA y no toca la red fiscal. Se puede llamar mil veces.
//
// QUÉ QUEDÓ ACÁ Y QUÉ NO
//
// Este archivo es la TOOL: el schema de entrada, la resolución de identidad, la
// orquestación (el store, la red del perfil y de "lo de siempre") y la forma de
// la respuesta MCP. Las reglas que deciden QUÉ VA EN EL COMPROBANTE —leer los
// importes que escribió una persona, volcar lo que el extractor sacó del texto
// sin pisar lo explícito, y armar el cuerpo para `biller_emitir_comprobante`—
// viven en [`kapso/borradorEmision.ts`](../kapso/borradorEmision.ts). Adentro
// de una tool eran inalcanzables desde cualquier otra superficie, y el día que
// la emisión entre por otro lado hay que reimplementarlas o importar una tool
// desde otra tool. Ver ARQUITECTURA §2.
// =============================================================================

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizarTelefono } from "../config.js";
import {
  aplicarAlItemEnCurso,
  borradorComprobante,
  formatearPrecioAviso,
  normalizarItems,
  rellenarDesdePedido,
} from "../kapso/borradorEmision.js";
import { fusionarEstado, type BorradorStore } from "../kapso/borradorStore.js";
import { KapsoClient } from "../kapso/client.js";
import {
  aplicarDefaults,
  clasificarDocumento,
  hoyDgi,
  interpretarPaso,
  indiceItemEnCurso,
  interpretarRespuestaLibre,
  itemSinNada,
  itemsVigentes,
  separarDireccionCiudad,
  siguientePaso,
  sugiereDolares,
  sugiereExportacion,
  PREFIJO_PASO,
  tipoComprobanteSugerido,
  type ClaseReceptor,
  type EstadoEmision,
  type PasoEmision,
  type PerfilCasa,
} from "../kapso/emision.js";
import {
  construirDesempateReceptor,
  construirListaClientes,
  construirSubmenuIva,
} from "../kapso/render.js";
import { extraerPedidoEmision, type PedidoEmision } from "../kapso/extraerPedido.js";
import { rankingClientes } from "../services/rankingClientes.js";
import { limpiarParaTitulo } from "../utils/texto.js";
import { extractClienteRut } from "../biller/normalize.js";
import { fetchEmitidos } from "../biller/queries.js";
import { CONCURRENCIA, mapConLimite } from "../biller/traerVentanas.js";
import { identidadDeConversacion, rechazoSesionAjena, remitenteSchema } from "../security/remitentes.js";
import { hoyComoDateUy, hoyIsoUy } from "../services/fechaUy.js";
import { parsearImporte } from "../services/importe.js";
import { aIso, consultarPorPeriodo } from "../services/periodo.js";
import {
  MUESTRAS_PERFIL,
  derivarPerfilCasa,
  elegirComprobanteARepetir,
  estadoDesdeComprobante,
  ultimasVentasAceptadas,
  type ResultadoRepeticion,
} from "../services/repetirUltima.js";
import { traerVentana } from "../services/ventana.js";
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
        "se guarda: se guarda un hash. Con el canal de WhatsApp configurado la sesión la manda " +
        "'remitente' y este parámetro es opcional: si lo mandás tiene que ser el MISMO usuario " +
        "(o el `sesion.id` que devolvió este server), no el número de otra persona.",
    ),
  /**
   * El remitente ya verificado por la barrera de entrada.
   *
   * Está declarado acá aunque `guardarEntrada` se lo agrega igual al schema de
   * toda tool, y no es redundancia: el input se parsea con `z.object`, que
   * DESCARTA lo que no esté en el shape. Sin esta línea el handler nunca lo ve
   * —el campo llega y se tira en silencio— y la sesión vuelve a quedar atada a
   * lo que elija el modelo. Ver `identidadDeSesion`.
   */
  remitente: remitenteSchema,
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

/** Los argumentos ya parseados. Es lo que ven las funciones de abajo. */
type ArgsEmision = z.infer<typeof inputSchema>;

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
  /**
   * El PERFIL DE LA CASA: los defaults que salieron del historial de la empresa
   * y no de la conversación. `campos` es el subconjunto de `defaults_aplicados`
   * que puso el perfil, y `porque` explica sobre cuántos comprobantes.
   *
   * Está para que el agente pueda contestar "¿por qué pusiste IVA incluido?"
   * sin inventar la respuesta. Todo lo que dice ya aparece en el preview.
   */
  perfil_casa: z
    .object({
      derivado: z.boolean(),
      muestras: z.number(),
      campos: z.array(z.string()),
      porque: z.array(z.string()),
    })
    .nullable(),
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
 * DE QUIÉN ES EL BORRADOR QUE SE VA A ABRIR.
 *
 * La decisión vive en `security/remitentes.ts` y no acá: es la MISMA que toman
 * `biller_emitir_comprobante` y `biller_menu_whatsapp`, y una regla de
 * autorización copiada en tres archivos es una regla que el cuarto archivo no
 * copia. Lo único propio de esta tool es el store contra el que se comparan las
 * claves y el rechazo, que se redacta con la envoltura de errores de acá.
 */
function identidadDeSesion(
  sesion: string | undefined,
  remitente: string | undefined,
  ctx: ToolContext,
  store: BorradorStore,
) {
  return identidadDeConversacion(sesion, remitente, () => ctx.getConfig(), (b) => store.clave(b));
}

/**
 * Las intenciones que NO son un campo del comprobante: las decide
 * `aplicarRespuestaDelUsuario` y las contesta el llamador.
 */
interface RespuestaDelUsuario {
  pidioDesempate: boolean;
  pidioOtroCliente: boolean;
  pidioOtraFecha: boolean;
  pidioOtraTasa: boolean;
  /** El toque tardío de "🗑️ Sacar $X" sobre un borrador que ya cambió. */
  descarteVencido: boolean;
}

/**
 * Aplica al estado lo último que hizo el usuario: el id de un botón nuestro o,
 * si no era un botón, el texto leído contra la pregunta que estaba abierta.
 *
 * Vive en su propia función porque es la única parte de `handleEmisionGuiada`
 * que MUTA el estado a partir de texto libre; mezclarla con el armado del
 * estado y con la respuesta hacía que las tres se leyeran como una sola cosa de
 * 550 líneas.
 */
function aplicarRespuestaDelUsuario(
  mensaje: string | undefined,
  estado: EstadoEmision,
  warnings: string[],
): RespuestaDelUsuario {
  // Un id de botón de este flujo pisa lo que haya: es lo último que hizo el
  // usuario, y es un dato explícito, no una inferencia.
  let pidioDesempate = false;
  let pidioOtroCliente = false;
  let pidioOtraFecha = false;
  let pidioOtraTasa = false;
  // El toque tardío de "🗑️ Sacar $X" sobre un borrador que ya cambió. No
  // descarta nada, y por eso mismo tiene que CONTESTAR algo.
  let descarteVencido = false;
  if (mensaje === undefined) {
    return { pidioDesempate, pidioOtroCliente, pidioOtraFecha, pidioOtraTasa, descarteVencido };
  }
  // Primero el id del botón; si no era un botón, se lee como texto CONTRA
  // LA PREGUNTA QUE ESTABA ABIERTA.
  //
  // El paso se calcula acá, ANTES de aplicar el mensaje: es el paso que el
  // usuario estaba contestando. Calcularlo después daría el paso siguiente,
  // y "sin identificar" se leería contra la pregunta que todavía no vio.
  let r = interpretarPaso(mensaje);
  if (r.paso === "ninguna") {
    r = interpretarRespuestaLibre(mensaje, siguientePaso(estado).paso, undefined, {
      // Distingue "¿Dirección y ciudad?" (primera vez) de "¿En qué ciudad?"
      // (la repregunta): con dirección ya cargada, el mensaje entero es la
      // ciudad y no hay que volver a partirlo por la coma. Ver issue 21.
      direccionYaCargada: (estado.direccion_cliente ?? "") !== "",
    });
  }
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
      delete estado.fecha_a_elegir;
      break;
    case "fecha_elegida":
      estado.fecha_emision = r.fecha;
      delete estado.fecha_a_elegir;
      break;
    case "vencimiento":
      estado.fecha_vencimiento = r.fecha;
      break;
    case "tasa_cambio":
      estado.tasa_cambio = r.tasa;
      break;
    case "datos_cliente_nuevo":
      // `direccion` puede faltar (la repregunta solo trae `ciudad`): cada
      // campo se escribe si vino, y el otro queda como estaba.
      if (r.direccion !== undefined) estado.direccion_cliente = r.direccion;
      if (r.ciudad !== undefined) estado.ciudad_cliente = r.ciudad;
      break;
    case "fecha_otra":
      // Tocó "otra fecha": no hay dato todavía, solo la intención. El paso
      // sigue siendo "fecha", pero preguntado como texto libre.
      //
      // La intención se GUARDA en el borrador —no alcanza con la variable del
      // turno— porque la fecha llega en el mensaje siguiente, y para entonces
      // el default ya habría repuesto "hoy". Ver `fecha_a_elegir`.
      estado.fecha_a_elegir = true;
      delete estado.fecha_emision;
      pidioOtraFecha = true;
      break;
    case "cantidad":
      aplicarAlItemEnCurso(estado, (item) => (item.cantidad = r.cantidad));
      break;
    case "precio":
      // Se propaga la ambigüedad igual que cuando el precio sale del
      // extractor (`ItemEnCurso.precio_ambiguo`): es lo que hace aparecer el
      // aviso en el preview para que el usuario confirme "6.50" antes de
      // emitir, y no se pierde por haber llegado a mano en vez de en el
      // mensaje inicial.
      aplicarAlItemEnCurso(estado, (item) => {
        item.precio = r.precio;
        if (r.ambiguo) item.precio_ambiguo = true;
        else delete item.precio_ambiguo;
      });
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
    case "item_cancelar": {
      // "↩️ Volver así": se descartan los ítems que se abrieron por error y
      // el flujo vuelve al preview. Se sacan los que no tienen NADA cargado
      // —ni descripción ni precio—, estén al final o en el medio: un ítem
      // con plata adentro es trabajo del usuario y se le pregunta, no se
      // tira (ver `itemSinNada`).
      //
      // El del MEDIO importa desde que el flujo dejó de esconderlo: si no se
      // pudiera descartar, la pregunta por su descripción no tendría salida
      // tocable. Y sacarlo del ESTADO —y no de una vista— es lo que mantiene
      // la alineación por posición, porque el borrador se arma después, de
      // este mismo estado ya compactado.
      const actuales = estado.items ?? [];
      if (actuales.length > 1) {
        const quedan = actuales.filter((i) => !itemSinNada(i));
        // Si no quedó ninguno, el flujo arranca de nuevo por el primer
        // concepto: es lo mismo que pasaba antes con el array vacío.
        estado.items = quedan;
      }
      estado.items_cerrados = true;
      break;
    }
    case "item_descartar": {
      // "🗑️ Sacar $250": el usuario decidió, LEYENDO EL MONTO, que esa
      // línea no va. Es lo único que puede sacar un ítem con plata cargada,
      // y por eso es un botón propio: `item_cancelar` tiene prohibido
      // hacerlo, justamente para que no se pierda sin querer.
      //
      // Se saca EL QUE SE ESTÁ PREGUNTANDO —el primero sin descripción—, no
      // el último: es el que nombra la pregunta que el usuario acaba de
      // leer. Se saca del ESTADO, así que el borrador se arma después ya sin
      // él y la alineación por posición con los ítems guardados se mantiene.
      const actuales = estado.items ?? [];
      // Se resuelve con las MISMAS dos funciones con las que el flujo eligió
      // qué preguntar, sobre la misma lista: si acá se buscara "el primero
      // sin concepto" a mano, un estado donde el ítem en curso es otro
      // haría que este botón sacara una línea que nadie nombró.
      const vigentes = itemsVigentes(estado);
      const enCurso = indiceItemEnCurso(vigentes);
      const candidato =
        enCurso !== -1 && (vigentes[enCurso]!.concepto ?? "") === "" ? enCurso : -1;
      // EL BOTÓN TIENE QUE SACAR LA LÍNEA QUE EL USUARIO LEYÓ, O NINGUNA.
      //
      // El id trae la posición y el precio que decía el mensaje. Si el
      // borrador cambió entre la pregunta y el toque —otro mensaje, la
      // línea ya completada, un ➕ en el medio—, lo que hay ahí ya no es lo
      // que él vio, así que no se toca nada. Y NO SE CALLA: un botón que no
      // hace nada ni contesta es el modo de falla que este repo ya arregló
      // dos veces (el número mudo).
      const coincide =
        candidato !== -1 &&
        (r.posicion === undefined || r.posicion === candidato + 1) &&
        (r.precio === undefined || r.precio === vigentes[candidato]!.precio);
      if (coincide) {
        estado.items = actuales.filter((_, i) => i !== candidato);
        warnings.push(
          `Se descartó la línea ${candidato + 1}, la que no tenía descripción: el usuario lo ` +
            "pidió con el botón que decía cuánto sacaba. Las demás siguen en su orden.",
        );
      } else {
        descarteVencido = true;
      }
      break;
    }
    case "item_conservar_precio":
    case "item_descartar_precio": {
      // El id congela posición y precio: un botón viejo nunca puede
      // conservar o borrar una línea distinta de la que la persona leyó.
      const actuales = estado.items ?? [];
      const vigentes = itemsVigentes(estado);
      const indice = indiceItemEnCurso(vigentes);
      const item = indice === -1 ? undefined : vigentes[indice];
      const coincide =
        item !== undefined &&
        indice + 1 === r.posicion &&
        item.precio === r.precio &&
        r.precio <= 0;
      if (coincide && r.paso === "item_conservar_precio") {
        estado.items = actuales.map((actual, i) =>
          i === indice ? { ...actual, precio_no_positivo_confirmado: true } : actual,
        );
        warnings.push(
          `Se conservará la línea ${indice + 1} con precio ${r.precio}: el usuario lo confirmó ` +
            "explícitamente.",
        );
      } else if (coincide) {
        estado.items = actuales.filter((_, i) => i !== indice);
        estado.items_cerrados = true;
        warnings.push(
          `Se descartó la línea ${indice + 1} con precio ${r.precio}: el usuario lo pidió ` +
            "explícitamente.",
        );
      } else {
        descarteVencido = true;
      }
      break;
    }
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
  return { pidioDesempate, pidioOtroCliente, pidioOtraFecha, pidioOtraTasa, descarteVencido };
}

/**
 * El estado que se deduce de los ARGUMENTOS de la llamada, antes de mirar el
 * store y antes del mensaje del usuario.
 *
 * Es la parte que convierte lo que escribió una persona en tipos: los importes
 * y la tasa de cambio los lee TypeScript (`services/importe.ts`) y no el
 * modelo, la dirección y la ciudad se separan con reglas escritas, y la moneda
 * queda "dudosa" si el texto habla de dólares. Todo lo que no se pudo leer sin
 * ambigüedad sale como warning para confirmarlo ANTES de emitir.
 */
function estadoDesdeArgumentos(a: ArgsEmision): {
  estadoArgs: EstadoEmision;
  warnings: string[];
} {
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
  return { estadoArgs, warnings };
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

  // --- De quién es este borrador ------------------------------------------
  //
  // ANTES QUE NADA, y en particular antes de tocar el store: `reiniciar` borra
  // y `repetir_ultima_de` prellena, así que resolver la identidad más abajo
  // dejaría un camino donde se destruye o se pisa el borrador de otro y recién
  // después se chequea de quién era. Ver `identidadDeSesion`.
  const store = ctx.getBorradorStore();
  const identidad = identidadDeSesion(a.sesion, a.remitente, ctx, store);
  if (!identidad.ok) return rechazoSesionAjena(identidad.mensaje, ctx);

  try {
    // Lo que se deduce de los argumentos: importes, tasa, dirección, moneda
    // dudosa. Ver `estadoDesdeArgumentos`.
    const { estadoArgs, warnings } = estadoDesdeArgumentos(a);

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
    // La clave la deriva el STORE, no una función suelta: es quien tiene la sal
    // de la empresa. Ver `BorradorStore.clave`. Y el identificador que entra ya
    // NO es el `sesion` crudo del modelo sino la identidad resuelta arriba: con
    // canal de WhatsApp abierto, el remitente que verificó la barrera.
    const clave = identidad.identidad === null ? null : store.clave(identidad.identidad);
    if (clave !== null && a.reiniciar) store.borrar(clave);

    const guardado = clave === null ? null : store.leer(clave);
    const estado: EstadoEmision =
      guardado === null ? estadoArgs : fusionarEstado(guardado.estado, estadoArgs);

    // --- El pedido, leído por TypeScript ------------------------------------
    //
    // "facturale a Pérez 2 bolsas de portland a 6.500" trae cuatro campos, y
    // hasta acá el único que los sacaba del texto era el modelo. Eso hacía que
    // el resultado dependiera de que hubiera copiado bien un número —y
    // `Number("6.500")` es 6,5—. Ahora el server lo vuelve a leer con
    // `extraerPedido.ts` y usa lo que saque SOLO PARA LLENAR HUECOS: un campo
    // que el agente mandó explícito no se toca nunca. Ver `rellenarDesdePedido`.
    //
    // Los ids de botón (`emision:*`) no pasan por acá: no son castellano, y
    // para ellos ya está `interpretarPaso` unas líneas más abajo.
    //
    // TAMPOCO CORRE EN UN PASO DONDE EL MENSAJE NO PUEDE SER UN PEDIDO
    // (issue 21). "Av. Italia 1234 apto 302, Montevideo" en el paso de la
    // dirección del cliente nuevo se leía como cliente "av italia" e ítem
    // "apto" × 1234 a $302 — con un ítem abierto, eso abre una línea FANTASMA
    // y avisa "NO emitas hasta cargarlos o descartarlos" sobre plata que
    // nadie dijo. Un número en el paso de la tasa de cambio, de la fecha o del
    // vencimiento tiene el mismo problema: no es un precio, es una cotización
    // o una fecha, y el extractor no sabe distinguirlos porque no sabe qué se
    // preguntó.
    //
    // EL PASO SE MIRA SOBRE EL ESTADO ANTERIOR A APLICAR EL MENSAJE: `estado`
    // en este punto es la fusión de lo guardado con los argumentos explícitos
    // de ESTA llamada, pero todavía no vio ni el pedido ni la respuesta libre
    // — es exactamente "lo que se sabía antes de que llegara este mensaje",
    // que es la pregunta que el usuario está contestando.
    const PASOS_SIN_PEDIDO: ReadonlySet<PasoEmision> = new Set([
      "datos_cliente_nuevo",
      "tasa_cambio",
      "fecha",
      "fecha_vencimiento",
    ]);
    const pasoAbierto = siguientePaso(estado).paso;
    const pedido: PedidoEmision | null =
      a.mensaje === undefined ||
      a.mensaje.trim().startsWith(PREFIJO_PASO) ||
      PASOS_SIN_PEDIDO.has(pasoAbierto)
        ? null
        : extraerPedidoEmision(a.mensaje);

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

    // Lo que el extractor pudo leer del texto, DESPUÉS de lo copiado y de lo
    // explícito: llena huecos y nada más. Ver `rellenarDesdePedido`.
    if (pedido !== null) {
      const { puestos, avisos } = rellenarDesdePedido(estado, pedido);
      // Lo que el extractor NO volcó y por qué. Un dato que se lee y se
      // descarta en silencio es indistinguible de uno que no se leyó.
      warnings.push(...avisos);
      if (puestos.length > 0) {
        warnings.push(
          `Del texto del usuario salieron ${puestos.length} dato(s) que no venían en los parámetros ` +
            `(${puestos.join(", ")}). Los leyó el server, no vos: verificalos en 'estado_entendido' ` +
            "y ecoálos en el preview antes de emitir.",
        );
      }
      for (const detalle of pedido.ambiguo ? pedido.detalles : []) {
        if (detalle.startsWith("Precio:")) warnings.push(`⚠️ ${detalle}`);
      }
      // El mensaje nombraba más venta de la que se pudo leer. Se avisa fuerte
      // Y el flujo ya quedó con un ítem abierto (ver `rellenarDesdePedido`):
      // el aviso solo, sin la pregunta, es lo que este hallazgo vino a cerrar.
      if (pedido.precios_sin_ubicar.length > 0) {
        const monedaAviso = estado.moneda ?? pedido.moneda;
        warnings.push(
          `⚠️ En el mensaje quedaron ${pedido.precios_sin_ubicar.length} precio(s) ` +
            `(${pedido.precios_sin_ubicar
              .map((precio) => formatearPrecioAviso(precio, monedaAviso))
              .join(", ")}) que no pertenecen a ninguna línea leída: ` +
            "el usuario nombró más de lo que se pudo entender. NO emitas todavía — preguntá qué " +
            "más se vendió y cargá esa línea con su cantidad y su concepto.",
        );
      }
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

    // Lo último que hizo el usuario pisa lo que haya: es un dato explícito, no
    // una inferencia. Ver `aplicarRespuestaDelUsuario`.
    const { pidioDesempate, pidioOtroCliente, pidioOtraFecha, pidioOtraTasa, descarteVencido } =
      aplicarRespuestaDelUsuario(a.mensaje, estado, warnings);

    // Qué sobrevivió gracias al store y no vino en esta llamada. Se calcula
    // DESPUÉS del botón: un campo que el botón acaba de fijar es "lo que el
    // usuario hizo recién", no algo recuperado — calcularlo antes lo listaba
    // igual. Se devuelven NOMBRES DE CAMPO, nunca valores: la respuesta sigue
    // sin sacar del server el concepto ni la adenda (ver `borradorComprobante`).
    const recuperado =
      guardado === null
        ? []
        : Object.keys(guardado.estado)
            // `perfil_casa` no es un dato del usuario sino un cache derivado
            // (ver `PerfilCasa`): listarlo acá diría "sin sesión esto se habría
            // vuelto a preguntar", y no es cierto — se habría vuelto a derivar.
            .filter((k) => k !== "perfil_casa")
            .filter(
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

    // --- El perfil de la casa ------------------------------------------------
    //
    // La capa de defaults que sale del HISTORIAL de la empresa, y va DEBAJO de
    // todo lo de arriba: de lo que dijo el usuario, de lo que se leyó de su
    // texto y de lo que copió `repetir_ultima_de`. Por eso se resuelve acá, al
    // final, cuando el estado ya tiene todo lo explícito: `convieneBuscarPerfil`
    // mira los huecos que QUEDARON, no los que había al empezar.
    //
    // UNA VEZ POR SESIÓN. Lo que se busca queda cacheado en `estado.perfil_casa`
    // —un cache derivado, no una respuesta del usuario, ver `PerfilCasa`— y en
    // los mensajes siguientes de la misma conversación no se vuelve a consultar.
    // Sin sesión no hay dónde cachearlo y se deriva cada vez, que sigue siendo
    // correcto y solo cuesta una consulta que casi siempre pega en el cache de
    // ventanas.
    let perfil: PerfilCasa | null = estado.perfil_casa ?? null;
    if (perfil === null && convieneBuscarPerfil(estado)) {
      try {
        perfil = await buscarPerfilCasa(ctx);
        // Se cachea incluso cuando no derivó NADA: "se miró y no alcanzó" es
        // una respuesta, y sin guardarla se volvería a mirar en cada mensaje.
        estado.perfil_casa = perfil;
      } catch (err) {
        // Un perfil que no se pudo derivar NO frena una emisión: se sigue
        // preguntando, que es exactamente la conducta de antes. Y no se cachea
        // el fracaso: una caída transitoria de la API no tiene por qué dejar a
        // la empresa sin perfil por el resto de la conversación.
        perfil = null;
        warnings.push(
          "No se pudo leer el historial para deducir cómo factura la casa " +
            `(${err instanceof Error ? err.message : String(err)}). Se pregunta como siempre.`,
        );
      }
    }

    // --- Qué sigue -----------------------------------------------------------
    let siguiente = siguientePaso(estado, { perfil });

    // LOS CLIENTES FRECUENTES: lo que mandó el agente, y si no mandó nada, los
    // que el server deduce del mismo historial que ya leyó para el perfil.
    //
    // El orden no es intercambiable: si el agente los pasó es porque viene de
    // `biller_ranking_clientes` con un criterio propio (buscó por nombre, filtró
    // por deuda), y eso le gana a la deducción genérica. La deducción existe
    // para cuando NO se acordó, que es el caso que dejaba al usuario tipeando
    // doce dígitos de RUT.
    let frecuentes = a.clientes_frecuentes ?? [];
    if (frecuentes.length === 0 && siguiente.paso === "cliente" && !pidioOtroCliente) {
      try {
        frecuentes = await buscarClientesFrecuentes(ctx);
      } catch {
        // Sin historial no hay lista, y sin lista se pregunta como siempre: es
        // un atajo, no un requisito. Una caída de la API no puede trancar una
        // emisión que el usuario puede completar escribiendo el RUT.
        frecuentes = [];
      }
    }

    // "✏️ Otra fecha" es la única respuesta que RETROCEDE el flujo: el usuario
    // descartó un dato que ya estaba resuelto (hoy, por default) y todavía no
    // dio el reemplazo. Sin este override, `siguientePaso` devolvería
    // "confirmar" con `listo: true` mientras le preguntamos la fecha — o sea,
    // le diríamos al agente "andá a emitir" en medio de una pregunta.
    if (pidioOtraFecha) {
      siguiente = { ...siguiente, paso: "fecha", listo: false };
    }

    // "🔢 Otro IVA" retrocede igual, y con el perfil de la casa dejó de ser un
    // caso imposible: si el perfil ya contestó las dos mitades del IVA,
    // `siguientePaso` diría "confirmar, listo" mientras nosotros le estamos
    // preguntando la tasa. Mismo arreglo que arriba, por el mismo motivo: el
    // flujo no puede decir "andá a emitir" en medio de una pregunta.
    if (pidioOtraTasa) {
      siguiente = { ...siguiente, paso: "iva", listo: false };
    }

    // EXPORTACIÓN: este flujo no la sabe armar, y no puede seguir como si nada.
    //
    // `tipoComprobanteSugerido` produce 101 o 111. Una exportación es un 121 con
    // indicador 10 y cuatro campos más que acá no se preguntan nunca. Sin este
    // freno, "facturale a mi cliente de España" terminaba en un 111 con IVA
    // 22%: un comprobante mal emitido ante DGI, que se corrige emitiendo otro.
    //
    // No se descarta el borrador ni se corta la conversación: se avisa y se
    // BLOQUEA el `listo`, que es lo que le diría al agente "andá a emitir". Si
    // era un falso positivo, el mensaje siguiente sin la palabra sigue derecho.
    const exportacion = a.mensaje !== undefined && sugiereExportacion(a.mensaje);
    if (exportacion) {
      siguiente = { ...siguiente, listo: false };
      warnings.push(
        "⛔ Esto parece una EXPORTACIÓN y este flujo no la sabe armar: solo produce e-Ticket (101) " +
          "y e-Factura (111). Una exportación es e-Factura de exportación (121) con " +
          "indicador_facturacion 10, y además exige modalidad_venta, clausula_venta, via_transporte " +
          "y el ncm de cada ítem. Emitirla como 111 le pone IVA 22% a una venta que no lo lleva. " +
          "Armala con biller_emitir_comprobante pasando el cuerpo completo, o consultá con tu " +
          "contador. Si NO es una exportación, repetí el pedido sin nombrar el exterior.",
      );
    }

    // El descarte que llegó tarde: se contesta lo que pasó y se vuelve a hacer
    // la pregunta que corresponda al estado de AHORA, que puede ser otra.
    if (descarteVencido) {
      warnings.push(
        "Llegó un 🗑️ para una línea que ya no está como estaba (se completó, se sacó, o el " +
          "borrador cambió): NO se descartó nada. Decíselo al usuario con estas palabras antes " +
          "de seguir.",
      );
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
    } else if (descarteVencido) {
      pregunta = `Esa línea ya no está como estaba, así que no saqué nada. ${siguiente.pregunta}`;
      interactivo = siguiente.interactivo;
    } else if (pidioOtraTasa) {
      // "🔢 Otro IVA": el paso sigue siendo el mismo (el IVA está sin resolver),
      // cambia el mensaje — de los tres botones fusionados a las tres tasas.
      interactivo = construirSubmenuIva();
      pregunta = "¿Qué IVA lleva? Tasa básica (22%), mínima (10%) o exento.";
    } else if (siguiente.paso === "cliente" && !pidioOtroCliente && frecuentes.length > 0) {
      const lista = construirListaClientes(frecuentes);
      // UNA FILA QUE NO SE PUEDE TOCAR DESAPARECE, Y ESO HAY QUE DECIRLO.
      //
      // `construirListaClientes` descarta a los clientes sin documento porque
      // el id de la fila ES el documento. El descarte es correcto —una fila que
      // no resuelve nada es peor que no estar—, pero en silencio el modelo cree
      // que ofreció cinco clientes y el usuario ve dos. Se avisa acá, donde el
      // agente puede arreglarlo mandando el RUT que ya tiene.
      const sinDocumento = (a.clientes_frecuentes ?? []).filter(
        (c) => (c.documento ?? "").trim() === "",
      ).length;
      if (sinDocumento > 0) {
        warnings.push(
          `${sinDocumento} de los clientes frecuentes que pasaste no traen documento, así que NO ` +
            "aparecen en la lista: la fila se identifica por RUT/CI y sin él el toque no resuelve " +
            "nada. Volvé a pasarlos con su documento (lo tiene biller_ranking_clientes) o dejá que " +
            "el usuario entre por “➕ Otro cliente”.",
        );
      }
      return await responder({
        a,
        ctx,
        exportacion,
        estado,
        siguiente,
        tipo,
        pregunta: "Elegí el cliente de la lista, o mandame el RUT.",
        interactivo: lista,
        documentoDetectado,
        warnings,
        // `desdeRevision` 0 cuando no había nada: "leí que no existía". Si al
        // guardar YA existe, otra llamada lo creó en el medio: se fusiona.
        sesion: { store, clave, recuperado, desdeRevision: guardado?.revision ?? 0 },
      });
    }

    return await responder({
      a,
      ctx,
      exportacion,
      estado,
      siguiente,
      tipo,
      pregunta,
      interactivo,
      documentoDetectado,
      warnings,
      sesion: { store, clave, recuperado, desdeRevision: guardado?.revision ?? 0 },
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
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
  // El campo que mueve el 22% del total tiene que estar en el espejo. Antes no
  // estaba y se notaba poco porque siempre lo había contestado el usuario; con
  // el perfil de la casa puede venir de un default, y un default que el agente
  // no puede ver es uno que no puede ecoar.
  if (estado.montos_brutos !== undefined) resumen["montos_brutos"] = estado.montos_brutos;
  if (estado.items_cerrados !== undefined) resumen["items_cerrados"] = estado.items_cerrados;
  // El texto de la adenda NO vuelve (barrera de salida); vuelve si está o no.
  if (estado.adenda !== undefined) resumen["adenda_cargada"] = estado.adenda.trim() !== "";
  if (estado.sin_adenda !== undefined) resumen["sin_adenda"] = estado.sin_adenda;
  // El VALOR del numero_interno no vuelve (ver `borradorComprobante`): vuelve si
  // existe. Alcanza para que el agente sepa que la deduplicación está puesta, y
  // no le da nada que copiar mal.
  if (estado.numero_interno !== undefined) resumen["numero_interno_generado"] = true;

  if (estado.items !== undefined) {
    resumen["items"] = estado.items.map((i) => ({
      // El texto NO vuelve; vuelve si estaba o no. Ver el comentario de arriba.
      concepto_cargado: (i.concepto ?? "") !== "",
      ...(i.cantidad !== undefined ? { cantidad: i.cantidad } : {}),
      ...(i.precio !== undefined ? { precio: i.precio } : {}),
      // El flag SÍ vuelve (no es texto de nadie, es un booleano nuestro): es lo
      // que le permite al agente ecoar la duda en vez de leer un total pelado.
      ...(i.precio_ambiguo === true ? { precio_ambiguo: true } : {}),
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
  /** true si el mensaje pidió una exportación: cambia el `como_sigue` entero. */
  exportacion?: boolean;
  documentoDetectado: ReturnType<typeof clasificarDocumento> | null;
  warnings: string[];
  sesion: { store: BorradorStore; clave: string | null; recuperado: string[]; desdeRevision?: number };
}): Promise<ToolResult> {
  const { a, ctx, estado, siguiente, tipo, pregunta, interactivo, documentoDetectado } = p;
  const exportacion = p.exportacion === true;
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
  const { store, clave, recuperado, desdeRevision } = p.sesion;
  let revision: number | null = null;
  // `desdeRevision` es la revisión que se leyó al ENTRAR, antes de los GET
  // contra la API. Si otra llamada de la misma conversación escribió en el
  // medio, el store fusiona en vez de pisarla. Ver `BorradorStore.guardar`.
  if (clave !== null) {
    revision = store.guardar(clave, estado, { desdeRevision: desdeRevision ?? 0 }).revision;
  }

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
    const resultado = await kapso.enviarInteractivo(destino, interactivo, {
      actorIdentity: a.remitente,
      operation: "paso_emision",
    });
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
  // El perfil de la casa entra por el estado (donde lo dejó cacheado el
  // handler) y se aplica acá, en la copia, junto a los demás defaults: es la
  // misma jerarquía —algo que el usuario no dijo— y sale por el mismo lugar,
  // el borrador que después arma el preview.
  const { estado: conDefaults, aplicados, del_perfil } = aplicarDefaults(estado);
  const { borrador, completar, incompletos } = borradorComprobante(
    conDefaults,
    tipo?.tipo_comprobante ?? null,
  );

  // UN ÍTEM A MEDIO CARGAR ES UN WARNING, NO UNA LÍNEA MENOS EN SILENCIO.
  //
  // Con el arreglo de `siguientePaso` este estado ya no llega a `listo`, así
  // que el camino normal no pasa por acá. Se avisa igual porque el borrador se
  // devuelve en TODOS los pasos —el agente lo puede tomar de cualquiera— y
  // porque `warnings` es lo que el agente mira antes de emitir, mientras que
  // `completar` lo lee cuando va a completar. El modo de falla que se está
  // tapando no es un 422: es una línea de un CFE real con la descripción de
  // otra (ver `borradorComprobante`).
  if (incompletos.length > 0) {
    warnings.push(
      `Hay ${incompletos.length} ítem(s) a medio cargar: ` +
        incompletos.map((i) => `el ${i.posicion} (sin ${i.falta.join(" ni ")})`).join(", ") +
        ". El comprobante_borrador corta en el primero, así que NO están todas las líneas. " +
        "Terminá de cargarlos antes de emitir.",
    );
  }
  const perfil = estado.perfil_casa ?? null;

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
    // Y con o sin perfil de la casa, por el mismo motivo: la hipótesis es que
    // el paso "iva" desaparece del embudo en las empresas que tienen perfil.
    // Va como ETIQUETA del embudo y no como métrica propia a propósito: la
    // pregunta ("¿el perfil sacó la pregunta de IVA?") es sobre el embudo, y
    // separada en otro contador no se podría cruzar.
    perfil:
      perfil === null
        ? "sin_buscar"
        : perfil.montos_brutos === undefined
          ? "sin_criterio_iva"
          : "con_criterio_iva",
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
    perfil_casa:
      perfil === null
        ? null
        : {
            derivado: true,
            muestras: perfil.muestras,
            campos: del_perfil,
            porque: perfil.detalles,
          },
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
    como_sigue: exportacion
      ? "PARÁ: esto parece una exportación y este flujo no la arma (ver 'warnings'). NO emitas nada " +
        "todavía. Explicale al usuario, con sus palabras, que una venta al exterior lleva otro tipo " +
        "de comprobante y otros campos, y preguntale si de verdad es una exportación."
      : siguiente.listo
      ? "Ya está todo. Pasá 'comprobante_borrador' a biller_requisitos_comprobante para el chequeo " +
        "final (umbral de UI, campos de DGI) y después a biller_emitir_comprobante SIN confirm, con " +
        "confirmar_por_whatsapp = el número de la conversación. Eso manda los botones ✅/✖️. " +
        "PASÁ SIEMPRE 'sesion' con el `sesion.id` de acá: es lo que completa el concepto de cada " +
        "ítem, la adenda y el numero_interno (la defensa contra emitir dos veces) desde el server."
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
  // EL PRECIO DE UN ÍTEM COPIADO YA ESTÁ DICHO, INCLUIDO EL 0.
  //
  // Sale de un CFE que se emitió de verdad, así que un 0 ahí es una línea
  // bonificada y no un hueco. Sin la marca, "lo de siempre" sobre una factura
  // con bonificación quedaba trancado pidiendo el precio de esa línea, sin
  // botones y sin ninguna respuesta que sirviera. Ver `precio_copiado`.
  if (r.estado.items !== undefined) {
    r.estado.items = r.estado.items.map((i) => ({ ...i, precio_copiado: true }));
  }
  // Copiado DEBAJO de lo dicho: fusionar con el estado actual encima.
  const fusionado = fusionarEstado(r.estado, estado);
  for (const clave of Object.keys(estado) as Array<keyof EstadoEmision>) delete (estado as Record<string, unknown>)[clave];
  Object.assign(estado, fusionado);
  return r;
}

// ---------------------------------------------------------------------------
// El perfil de la casa: cuándo se busca y cómo
// ---------------------------------------------------------------------------

/**
 * Qué tan atrás se mira para saber cómo factura la casa. Noventa días.
 *
 * Es la ventana que ya usan las demás tools de período, así que en un proceso
 * vivo el listado suele salir del cache de ventanas sin tocar la API (ver
 * `services/ventana.ts`). Más corto se queda sin muestra en una empresa que
 * factura poco; más largo empieza a describir una costumbre que ya cambió.
 */
export const DIAS_PERFIL = 90;

/** Nueve clientes y la fila de "➕ Otro cliente": el tope de 10 filas de WhatsApp. */
export const MAX_CLIENTES_FRECUENTES = 9;

/**
 * ¿Vale la pena ir a buscar el perfil AHORA?
 *
 * Dos condiciones, y las dos son de costo, no de corrección:
 *
 *   1. Que ya haya una LÍNEA CON PRECIO. El perfil no cambia ninguna pregunta
 *      anterior a esa —a quién le facturás, qué le vendiste, a cuánto—, y el
 *      embudo dice que la enorme mayoría de las conversaciones se abandona
 *      antes de llegar ahí. Disparar una consulta de noventa días en cada
 *      "quiero facturar" sería gastar el rate limit de la empresa en
 *      conversaciones que no van a existir.
 *   2. Que quede algo que el perfil pueda contestar. Cuando el usuario ya dijo
 *      el criterio de IVA y la tasa —o los copió `repetir_ultima_de`—, el
 *      perfil no tiene nada que aportar y la consulta sería pura latencia.
 *
 * La corrección no depende de esto: si no se busca, el flujo se comporta
 * exactamente como antes de que el perfil existiera.
 */
export function convieneBuscarPerfil(estado: EstadoEmision): boolean {
  const items = estado.items ?? [];
  const hayLinea = items.some(
    (i) => (i.concepto ?? "") !== "" && typeof i.precio === "number" && i.precio > 0,
  );
  if (!hayLinea) return false;

  const tasaResuelta =
    estado.indicador_facturacion !== undefined ||
    items.every((i) => i.indicador_facturacion !== undefined);
  const monedaResuelta = (estado.moneda ?? "") !== "" || estado.moneda_dudosa === true;

  return !(
    estado.montos_brutos !== undefined &&
    tasaResuelta &&
    monedaResuelta &&
    estado.forma_pago !== undefined
  );
}

/**
 * Trae los últimos CFE aceptados de la empresa y deriva el perfil.
 *
 * DOS CONSULTAS Y NO UNA, y la segunda es la cara: el listado no trae ítems, y
 * la tasa de IVA vive en los ítems. Así que se piden los detalles de los
 * `MUESTRAS_PERFIL` últimos, en paralelo acotado (el mismo techo que usan las
 * ventanas). Son cinco GET de lectura, una sola vez por sesión de emisión —
 * después queda cacheado en el borrador y no se vuelve a pedir.
 *
 * El listado sí pasa por `traerVentana`, o sea por el cache compartido, el
 * recorte por fecha de EMISIÓN y el contador de cache por empresa. Reusarlo en
 * vez de consultar a mano es lo que hace que este perfil cuente los mismos
 * comprobantes que cuenta el resto del sistema.
 */
/**
 * Los clientes a los que esta empresa le factura seguido, para ofrecerlos como
 * lista tocable en el paso `cliente`.
 *
 * POR QUÉ LO HACE EL SERVER Y NO EL AGENTE. `clientes_frecuentes` existía desde
 * antes, pero solo llegaba si el modelo se acordaba de llamar a
 * `biller_ranking_clientes` y pasar el resultado. Cuando no se acordaba —y no
 * se acordaba— el usuario terminaba tipeando doce dígitos de RUT desde el
 * mostrador. El dato no era el problema: el problema era de quién dependía.
 *
 * NO CUESTA UNA CONSULTA NUEVA. Es la MISMA ventana de 90 días que ya trae
 * `buscarPerfilCasa`, y `traerVentana` la sirve del cache. Por eso se deriva
 * acá y no con otra tool.
 *
 * Solo salen los que tienen documento: el id de la fila ES el documento, que es
 * lo que el paso `cliente` sabe leer. Un cliente sin RUT no se puede ofrecer
 * como fila porque tocarla no resolvería nada (ver `construirListaClientes`).
 */
export async function buscarClientesFrecuentes(
  ctx: ToolContext,
): Promise<Array<{ nombre: string; documento: string }>> {
  const hoy = hoyComoDateUy();
  const desde = aIso(new Date(hoy.getTime() - DIAS_PERFIL * 86_400_000));
  const hasta = hoyIsoUy(hoy);

  const ventana = await traerVentana(ctx, { rango: { desde, hasta } });
  const ranking = rankingClientes(ventana.comprobantes, {
    desde,
    hasta,
    limite: MAX_CLIENTES_FRECUENTES,
  });

  return ranking.clientes
    .filter((c) => c.rut !== null && (c.nombre ?? "").trim() !== "")
    .slice(0, MAX_CLIENTES_FRECUENTES)
    .map((c) => ({
      // El nombre lo escribió un tercero (o DGI) y viaja al TÍTULO de una fila
      // de WhatsApp, que se recorta a 24 caracteres. Se neutralizan los
      // delimitadores de la barrera para que nadie pueda cerrar la envoltura
      // desde adentro, y los caracteres de control, que no se ven pero rompen
      // el JSON del payload.
      nombre: limpiarParaTitulo(c.nombre!),
      documento: c.rut!,
    }));
}

export async function buscarPerfilCasa(ctx: ToolContext): Promise<PerfilCasa> {
  const hoy = hoyComoDateUy();
  const desde = aIso(new Date(hoy.getTime() - DIAS_PERFIL * 86_400_000));
  const hasta = hoyIsoUy(hoy);

  const ventana = await traerVentana(ctx, { rango: { desde, hasta } });
  const candidatos = ultimasVentasAceptadas(ventana.comprobantes, MUESTRAS_PERFIL);
  if (candidatos.length < MUESTRAS_PERFIL) {
    // Sin muestra suficiente no se piden los detalles: sería gastar cinco
    // requests para confirmar que no hay perfil. `derivarPerfilCasa` devuelve
    // igual el perfil vacío, con el detalle de por qué.
    return derivarPerfilCasa(candidatos, { desde, hasta, ventana: ventana.comprobantes });
  }

  const client = ctx.getClient();
  const detalles = await mapConLimite(candidatos, CONCURRENCIA, async (c) => {
    if (c.id === null || c.id === undefined) return null;
    return (await fetchEmitidos(client, { id: String(c.id) }))[0] ?? null;
  });

  const utiles = detalles.filter((d): d is NonNullable<typeof d> => d !== null);
  // La VENTANA ENTERA va junto con los cinco detalles, y no es redundante: la
  // tasa de IVA solo existe en los detalles, pero `montos_brutos` viene en el
  // listado, y evaluarlo sobre cinco cuando hay doscientos en memoria hacía que
  // una racha pasara por costumbre. Ver `derivarPerfilCasa`.
  return derivarPerfilCasa(utiles, { desde, hasta, ventana: ventana.comprobantes });
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
        "Además deduce el PERFIL DE LA CASA de las últimas facturas de la empresa: si todas " +
        "coinciden en el criterio de IVA y en la tasa, tampoco se pregunta eso (y sale igual escrito " +
        "en el preview). Lo derivado viene en 'perfil_casa', con el porqué. " +
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
