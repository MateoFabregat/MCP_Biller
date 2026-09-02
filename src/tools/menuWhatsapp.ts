// =============================================================================
// biller_menu_whatsapp
//
// Es lo que contesta el asistente cuando llega un "hola" por WhatsApp.
//
// Dos modos, y la diferencia importa:
//
//   enviar=false (default) -> devuelve el menú en texto y las opciones
//                             estructuradas. El agente de Kapso lo escribe como
//                             respuesta normal. Sin efectos, sin red.
//   enviar=true            -> manda el menú como LISTA INTERACTIVA de WhatsApp
//                             (las filas que se tocan). Requiere allowlist.
//
// El interactivo no es cosmética: en un teléfono, tocar una fila es una acción
// y escribir "quiero ver quién me debe plata" son quince. La diferencia entre
// las dos es si el dueño de la PyME lo usa todos los días o una vez.
//
// La tool también sirve de ENRUTADOR: pasándole `mensaje` devuelve qué opción
// eligió el usuario y qué tool corresponde llamar. Eso saca la decisión de
// "¿esto qué era?" del prompt y la pone en código testeado — el modelo sigue
// entendiendo el lenguaje, pero el mapa de opciones a tools es fijo.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizarTelefono } from "../config.js";
import { KapsoClient } from "../kapso/client.js";
import { identidadDeConversacion, rechazoSesionAjena, remitenteSchema } from "../security/remitentes.js";
import {
  construirDesambiguacion,
  construirMenuInteractivo,
  construirMenuTexto,
  interpretarMensaje,
  opcionesDisponibles,
  type MenuOpcion,
} from "../kapso/menu.js";
import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  simpleErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  mensaje: z
    .string()
    .optional()
    .describe(
      "Lo que escribió (o tocó) el usuario. Si viene, la tool interpreta qué opción eligió y " +
        'devuelve qué tool corresponde llamar. Un saludo ("hola") o algo que no matchea ninguna ' +
        "opción devuelve el menú.",
    ),
  sesion: z
    .string()
    .optional()
    .describe(
      "Identificador de la conversación — el número de WhatsApp, o el 'sesion.id' que devolvió " +
        "biller_emision_guiada. PASALO SIEMPRE que exista una conversación: con esto el server " +
        "MIRA SI HAY UN BORRADOR A MEDIO CARGAR y deduce 'en_flujo' solo, sin que tengas que " +
        "acordarte vos. El número no se guarda: se guarda un hash.",
    ),
  /**
   * El remitente ya verificado y normalizado por la barrera de entrada.
   *
   * Declarado acá porque el `z.object` de esta tool descarta lo que no está en su
   * shape, y sin él no habría contra qué contrastar la 'sesion' que elige el
   * modelo. Ver `identidadDeConversacion`.
   */
  remitente: remitenteSchema,
  en_flujo: z
    .boolean()
    .optional()
    .describe(
      "OVERRIDE de lo que el server deduce con 'sesion'. Normalmente NO hace falta mandarlo. " +
        "true si hay una emisión guiada A MEDIO CARGAR en esta conversación: cambia el default del " +
        'enrutador, y lo que no matchea nada ("pará, eran 3 no 2", "que sean de 25kg") se devuelve ' +
        "como respuesta del flujo (via=flujo_emision) para pasarle a biller_emision_guiada, en vez " +
        'de contestar el menú en medio de la carga. "menú", "cancelá" y "dale" siguen ganando.',
    ),
  enviar: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Si es true, manda el menú como mensaje interactivo de WhatsApp (lista tocable) en vez de " +
        "solo devolver el texto. Requiere Kapso configurado y destinatario en la allowlist.",
    ),
  destinatario: z
    .string()
    .optional()
    .describe(
      "Número de WhatsApp en formato internacional (ej. 59895923567). Obligatorio si enviar=true.",
    ),
  formato: z
    .enum(["lista", "texto"])
    .optional()
    .default("lista")
    .describe(
      "Con enviar=true: 'lista' manda el interactivo tocable; 'texto' manda el mismo menú como " +
        "mensaje de texto numerado. Usá 'texto' si el interactivo no está disponible.",
    ),
};

const inputSchema = z.object(inputShape);

const outputShape = {
  texto: z.string(),
  opciones: z.array(
    z.object({
      numero: z.number(),
      id: z.string(),
      titulo: z.string(),
      // Se llama `subtitulo` y no `descripcion` a propósito: `descripcion` está
      // en CAMPOS_NO_CONFIABLES (src/security/untrusted.ts), así que la barrera
      // de salida lo envolvería en ⟦dato-no-confiable⟧. Correcto para el texto
      // de un ítem que escribió un tercero; absurdo para nuestro propio menú, y
      // el modelo lo leería como contenido sospechoso. La barrera compara por
      // nombre de clave a propósito: el que se adapta es este campo, no ella.
      subtitulo: z.string(),
      grupo: z.string(),
      tools: z.array(z.string()),
    }),
  ),
  interpretacion: z
    .object({
      mensaje: z.string(),
      via: z.string(),
      opcion_id: z.string().nullable(),
      opcion_titulo: z.string().nullable(),
      tools_sugeridas: z.array(z.string()),
      mostrar_menu: z.boolean(),
      /** Qué contestar cuando no hay tool que llamar. Nunca es null y vacío a la vez. */
      respuesta_sugerida: z.string().nullable(),
      /** 0..1 cuando via="aproximado": el match es por parecido, no exacto. */
      confianza: z.number().nullable(),
      /**
       * Cuando via="ambiguo": entre qué opciones hay que elegir. Con enviar=true
       * ya salieron como botones; si no, preguntá con 'respuesta_sugerida'.
       */
      candidatas: z.array(z.object({ id: z.string(), titulo: z.string(), tools: z.array(z.string()) })),
      /** El token del botón ✅, ya sin el prefijo "emitir:si:". Listo para confirm. */
      confirmation_token: z.string().nullable(),
      /** Cuando via="resolucion_elegida": qué candidato tocó, por índice. */
      resolucion: z
        .object({ tipo: z.enum(["cliente", "producto"]), indice: z.number() })
        .nullable(),
      /**
       * Cuando via="pedido_emision": qué campos del comprobante trae el
       * mensaje, POR NOMBRE. Los valores no salen de acá — los vuelve a leer
       * biller_emision_guiada con el mismo extractor. Ver `Interpretacion`.
       */
      pedido_campos: z.array(z.string()),
      /** true si el enrutador trabajó sabiendo que había una carga a medio hacer. */
      en_flujo: z.boolean(),
      /** true si `en_flujo` lo dedujo el server del borrador, y no lo mandó el agente. */
      en_flujo_derivado: z.boolean(),
      /** La instrucción concreta para el agente. Siempre hay una. */
      siguiente_accion: z.string(),
    })
    .nullable(),
  capability_mode: z.string(),
  envio: z.object({
    solicitado: z.boolean(),
    realizado: z.boolean(),
    formato: z.string().nullable(),
    motivo: z.string().nullable(),
    destinatario_sufijo: z.string().nullable(),
    message_id: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
};

/**
 * La instrucción concreta para el agente, para CADA forma de interpretar.
 *
 * Existe porque el modo de fallar de este flujo no es contestar mal: es no
 * contestar. El agente que recibe `via: "cortesia"` sin nada más puede
 * razonablemente decidir que no hay nada que hacer y quedarse callado — y del
 * otro lado hay alguien mirando un visto. Acá no hay ninguna rama que devuelva
 * "nada": el switch es exhaustivo a propósito y TypeScript lo verifica.
 */
function siguienteAccion(r: ReturnType<typeof interpretarMensaje>): string {
  switch (r.via) {
    case "id":
    case "numero":
    case "sinonimo":
      return (
        `El usuario eligió "${r.opcion?.titulo}". Llamá a ${r.opcion?.tools.join(" o ")} y contestá ` +
        "con el resultado." +
        (r.opcion?.id === "menu:emitir"
          ? " Para esta opción empezá SIEMPRE por biller_emision_guiada con enviar=true: manda el " +
            "submenú de a quién se le factura, y de ahí sale solo el tipo de comprobante."
          : "") +
        (r.opcion?.id === "menu:repetir"
          ? " El usuario quiere REPETIR la última factura de un cliente. Averiguá el RUT (con " +
            "biller_resolver_nombre si dio un nombre) y llamá a biller_emision_guiada con " +
            "repetir_ultima_de=<documento> y sesion=<número de la conversación>. El server copia " +
            "ítems, precios, IVA y forma de pago de la última venta aceptada; NO le preguntes al " +
            "usuario nada de eso. Solo van a quedar la fecha y, si era a crédito, el vencimiento."
          : "")
      );
    case "aproximado":
      return (
        `Probablemente quiso decir "${r.opcion?.titulo}". Llamá a ${r.opcion?.tools.join(" o ")}, ` +
        "contestá, y agregá una línea corta ofreciendo el menú por si no era eso."
      );
    case "ambiguo":
      return (
        `Lo que escribió apunta a ${r.candidatas?.length ?? 2} cosas distintas ` +
        `(${(r.candidatas ?? []).map((o) => `"${o.titulo}"`).join(", ")}) y contestar la que no era ` +
        "es peor que preguntar. Si mandaste esta tool con enviar=true, los botones ya salieron: no " +
        `repitas la pregunta en texto. Si no, preguntá corto: "${r.respuesta_sugerida}". Cuando ` +
        "conteste te va a llegar el id de la opción y seguís normal."
      );
    case "saludo":
      return "Mandá el menú: llamá a esta misma tool con enviar=true y el número de la conversación.";
    case "cortesia":
      return `Contestá algo corto tipo: "${r.respuesta_sugerida}". NO mandes el menú.`;
    case "no_disponible":
      return `Explicale por qué no se puede, con esto: "${r.respuesta_sugerida}". Después ofrecé lo que SÍ podés hacer.`;
    case "emision_confirmada":
      return (
        "El usuario tocó ✅ Emitir en el preview. Llamá a biller_emitir_comprobante con confirm=true, " +
        "el MISMO cuerpo del dry-run sin cambiarle nada, y confirmation_token = el campo " +
        "'confirmation_token' de esta respuesta (ya viene sin el prefijo del botón). No vuelvas a " +
        "preguntar nada ni pases por el menú. Si el token da vencido, avisá que el preview caducó y " +
        "rehacé el dry-run para que confirme de nuevo."
      );
    case "emision_cancelada":
      return (
        `El usuario tocó ✖️ Cancelar: NO emitas nada. Contestá corto, tipo "${r.respuesta_sugerida}". ` +
        "No mandes el menú ni vuelvas a arrancar la emisión: cancelar significa que no quiere seguir."
      );
    case "anulacion_revisada":
      return (
        "El usuario completó el paso 1 de 2. Volvé a llamar biller_anular_comprobante con el " +
        "MISMO identificador, fecha_emision_hoy y confirmar_por_whatsapp, todavía SIN confirm=true, " +
        "con confirmacion_revisada=true y revision_token = el campo 'revision_token' de esta " +
        "respuesta. Conservá también el mismo remitente. Eso manda el botón final; no anules todavía."
      );
    case "anulacion_confirmada":
      return (
        "El usuario completó el paso 2 de 2. Llamá a biller_anular_comprobante con confirm=true, " +
        "el MISMO identificador y fecha_emision_hoy del preview, y confirmation_token = el campo " +
        "'confirmation_token' de esta respuesta. Conservá también confirmacion_revisada=true, el " +
        "revision_token del paso anterior y el mismo remitente. No cambies el comprobante."
      );
    case "anulacion_cancelada":
      return "El usuario eligió no anular. No ejecutes ningún POST y confirmale que no se cambió nada.";
    case "afirmacion":
      return (
        `El usuario dijo que sí. ${r.respuesta_sugerida} ` +
        "Fijate cuál era la última pregunta que le hiciste y aplicá el sí ahí."
      );
    case "cancelacion":
      return (
        `El usuario quiere frenar. ${r.respuesta_sugerida} ` +
        "Si había un dry-run pendiente, descartalo: el token vence solo y no hay nada que revertir."
      );
    case "resolucion_elegida":
      return (
        `El usuario eligió el candidato #${(r.resolucion?.indice ?? 0) + 1} de la última respuesta de ` +
        "biller_resolver_nombre (el array 'candidatos', base 0). Tomá ESE nombre y documento y seguí " +
        "con lo que estaban haciendo — no vuelvas a resolver ni mandes el menú. Si ya no tenés esa " +
        "lista en el contexto, volvé a llamar a biller_resolver_nombre con el MISMO texto: el orden " +
        "de los candidatos es determinístico y el índice sigue valiendo."
      );
    case "flujo_emision":
      return (
        "Esto es una respuesta del flujo de emisión guiada, no del menú. Pasásela tal cual a " +
        "biller_emision_guiada (en 'mensaje'), junto con TODO lo que ya sepas de la conversación. " +
        "No la interpretes acá ni mandes el menú: hacerlo tira a la basura los datos que ya juntaste."
      );
    case "pedido_emision":
      return (
        "El mensaje NO matcheó ninguna opción del menú, pero es un pedido de facturación con datos " +
        `adentro: el server le leyó ${(r.pedido_campos ?? []).length} campo(s) ` +
        `(${(r.pedido_campos ?? []).join(", ")}). Llamá a biller_emision_guiada pasándole el TEXTO ` +
        "TAL CUAL en 'mensaje' y la 'sesion' de la conversación: el server lo vuelve a leer con el " +
        "mismo extractor y prellena el borrador solo. NO copies vos el precio ni la cantidad — " +
        'Number("6.500") es 6,5 y en Uruguay son seis mil quinientos; esa conversión la hace ' +
        "TypeScript. Contestá únicamente la pregunta que devuelva la tool."
      );
    case "desconocido":
      return (
        "No matcheó ninguna opción. Si es una pregunta concreta sobre facturación, contestala con " +
        "la tool que corresponda (biller_catalogo_datos dice qué se puede). Si de verdad no se " +
        "entiende, mandá el menú con enviar=true. Lo único que NO podés hacer es no contestar."
      );
  }
}

export async function handleMenuWhatsapp(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) {
    return simpleErrorResult(`Parámetros inválidos: ${parsed.error.issues[0]?.message ?? ""}`, ctx);
  }
  const a = parsed.data;

  if (a.enviar && (a.destinatario === undefined || a.destinatario.trim() === "")) {
    return simpleErrorResult(
      "Para enviar el menú hace falta 'destinatario' (número de WhatsApp en formato internacional, " +
        "ej. 59895923567).",
      ctx,
    );
  }

  try {
    const config = ctx.getConfig();
    const warnings: string[] = [];

    // EL "ESTOY EN MEDIO DE UNA CARGA" LO SABE EL SERVER, NO EL MODELO.
    //
    // `en_flujo` era un booleano que tenía que acordarse de mandar el agente, y
    // el modo de falla era silencioso y caro: en medio de una emisión, "pará,
    // eran 3 no 2" con `en_flujo` olvidado cae en `desconocido` y el webhook
    // AUTORRESPONDE el menú — la carga a medio hacer se pierde y el usuario
    // recibe diez opciones como respuesta a una corrección.
    //
    // El dato ya existe del lado del server: o hay un borrador vivo para esa
    // sesión o no lo hay. Se lee de ahí, y el booleano explícito queda como
    // override para el llamador que sepa algo que el store no.
    //
    // Y SE MIRA EL BORRADOR PROPIO, NO EL DE LA `sesion` QUE ELIJA EL MODELO. La
    // fuga acá es chica —un booleano: "ese otro número tiene una factura a medio
    // cargar"— pero es el mismo patrón que dejaba leer el borrador ajeno y emitir
    // con sus líneas, así que se cierra con la misma decisión compartida. Ver
    // `identidadDeConversacion`.
    let enFlujo = a.en_flujo ?? false;
    let flujoDerivado = false;
    if (a.en_flujo === undefined && a.sesion !== undefined && a.sesion.trim() !== "") {
      const store = ctx.getBorradorStore();
      const identidad = identidadDeConversacion(
        a.sesion,
        a.remitente,
        () => ctx.getConfig(),
        (b) => store.clave(b),
      );
      if (!identidad.ok) return rechazoSesionAjena(identidad.mensaje, ctx);
      if (identidad.identidad !== null) {
        enFlujo = store.leer(store.clave(identidad.identidad)) !== null;
        flujoDerivado = true;
      }
    }

    const opcionesMenu = {
      capabilityMode: config.capabilityMode,
      empresa: config.defaultEmpresaRut,
      en_flujo: enFlujo,
    };

    const disponibles = opcionesDisponibles(opcionesMenu);
    const texto = construirMenuTexto(opcionesMenu);

    // --- Enrutado del mensaje del usuario -----------------------------------
    let interpretacion: Record<string, unknown> | null = null;
    let candidatas: MenuOpcion[] = [];
    if (a.mensaje !== undefined) {
      const r = interpretarMensaje(a.mensaje, opcionesMenu);
      candidatas = r.candidatas ?? [];

      // LA MÉTRICA MÁS IMPORTANTE DEL PRODUCTO.
      //
      // `via` dice CÓMO se resolvió el mensaje, y la proporción de
      // `desconocido` es la respuesta a "¿esto entiende a la gente?". Se cuenta
      // el `via` y el id de la opción —dos vocabularios cerrados— y NUNCA el
      // texto del mensaje: ahí adentro puede haber nombres de clientes,
      // importes o el número de una factura.
      //
      // `interpretarMensaje` sigue siendo puro: se mide acá, en el borde, y no
      // adentro. Un módulo puro se puede testear con 155 mensajes de corrido;
      // uno que escribe métricas, no.
      ctx.metricas.contar("enrutador.mensaje", {
        via: r.via,
        opcion: r.opcion?.id.replace("menu:", "") ?? "ninguna",
      });
      interpretacion = {
        mensaje: a.mensaje,
        via: r.via,
        opcion_id: r.opcion?.id ?? null,
        opcion_titulo: r.opcion?.titulo ?? null,
        tools_sugeridas: r.opcion?.tools ?? [],
        mostrar_menu: r.mostrar_menu,
        respuesta_sugerida: r.respuesta_sugerida ?? null,
        confianza: r.confianza ?? null,
        candidatas: candidatas.map((o) => ({ id: o.id, titulo: o.titulo, tools: o.tools })),
        confirmation_token: r.confirmation_token ?? null,
        resolucion: r.resolucion ?? null,
        pedido_campos: r.pedido_campos ?? [],
        en_flujo: enFlujo,
        en_flujo_derivado: flujoDerivado,
        siguiente_accion: siguienteAccion(r),
      };
      if (r.via === "ambiguo") {
        warnings.push(
          `"${a.mensaje}" apunta a más de una opción (${candidatas.map((o) => o.titulo).join(", ")}). ` +
            "No elijas vos: preguntá cuál. Contestar la que no era gasta la confianza que después " +
            "hace falta para los números.",
        );
      }
      if (r.via === "desconocido") {
        warnings.push(
          `No se pudo mapear "${a.mensaje}" a ninguna opción del menú. Eso NO significa que no se ` +
            "pueda contestar: si es una pregunta concreta sobre facturación, contestala con la tool " +
            "que corresponda en vez de devolver el menú.",
        );
      }
      if (r.via === "aproximado") {
        warnings.push(
          `"${a.mensaje}" se pareció a "${r.opcion?.titulo}" por palabras, no exactamente ` +
            `(coincidencia ${Math.round((r.confianza ?? 0) * 100)}%). Contestá esa pregunta, pero si la ` +
            "respuesta no encaja con lo que preguntó, decilo y ofrecé el menú.",
        );
      }
      if (r.via === "no_disponible") {
        warnings.push(r.respuesta_sugerida ?? "Esa opción no está habilitada en este server.");
      }
    }

    // --- Envío (opt-in) ------------------------------------------------------
    let realizado = false;
    let motivo: string | null = null;
    let messageId: string | null = null;
    let sufijo: string | null = null;
    let formatoUsado: string | null = null;

    if (!a.enviar) {
      motivo = "No se solicitó envío (enviar=false): el menú se devuelve como texto.";
    } else if (config.kapso === undefined) {
      motivo = "Kapso no está configurado: falta KAPSO_API_KEY. El menú se devolvió igual, sin enviarse.";
      warnings.push(motivo);
    } else {
      const destino = normalizarTelefono(a.destinatario!);
      sufijo = destino.slice(-4);
      const kapso = new KapsoClient(config.kapso);

      // Un empate no se contesta con el menú entero. El usuario ya escribió lo
      // que quería; devolverle diez opciones es hacerlo empezar de cero. Salen
      // las dos o tres cosas que su mensaje puede significar, como botones.
      const resultado =
        candidatas.length > 1
          ? await kapso.enviarInteractivo(destino, construirDesambiguacion(candidatas))
          : a.formato === "texto"
            ? await kapso.enviar(destino, texto)
            : await kapso.enviarInteractivo(destino, construirMenuInteractivo(opcionesMenu));
      realizado = true;
      formatoUsado = candidatas.length > 1 ? "desambiguacion" : a.formato;
      messageId = resultado.message_id;
    }

    if (config.capabilityMode !== "write_enabled") {
      warnings.push(
        "El server está en modo lectura (BILLER_CAPABILITY_MODE=read_only): el menú no ofrece emitir " +
          "comprobantes porque esa tool no está registrada.",
      );
    }

    return jsonResult({
      texto,
      opciones: disponibles.map((o, i) => ({
        numero: i + 1,
        id: o.id,
        titulo: o.titulo,
        subtitulo: o.descripcion,
        grupo: o.grupo,
        tools: o.tools,
      })),
      interpretacion,
      capability_mode: config.capabilityMode,
      envio: {
        solicitado: a.enviar,
        realizado,
        formato: formatoUsado,
        motivo,
        destinatario_sufijo: sufijo,
        message_id: messageId,
      },
      warnings,
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerMenuWhatsapp(server: McpServer, ctx: ToolContext): void {
  const puedeEnviar = (() => {
    try {
      return ctx.getConfig().kapso !== undefined;
    } catch {
      return false;
    }
  })();

  server.registerTool(
    "biller_menu_whatsapp",
    {
      title: "Menú de WhatsApp",
      description:
        "El menú de opciones del asistente por WhatsApp, y el enrutador de lo que escribe el " +
        'usuario. Llamala cuando la conversación arranca ("hola", "menú", "ayuda") o cuando no ' +
        "quede claro qué está pidiendo: devuelve las opciones disponibles y, si le pasás " +
        "'mensaje', a qué opción corresponde y qué tool llamar. PASALE SIEMPRE 'sesion' (el número " +
        "de la conversación): con eso el server mira si hay una emisión a medio cargar y entiende " +
        'una corrección ("pará, eran 3 no 2") como respuesta del flujo en vez de contestar el menú ' +
        "en el medio. También reconoce pedidos de facturación escritos con datos adentro " +
        '("perez 2 bolsas portland 6500") aunque no matcheen ninguna opción. Por defecto solo ' +
        "devuelve el texto; con enviar=true lo manda como lista interactiva tocable al número " +
        "indicado, que debe estar en la allowlist.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      // Igual que el reporte diario: cuando puede enviar deja de ser read-only.
      annotations: puedeEnviar
        ? { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Menú de WhatsApp" }
        : { ...READ_ONLY_ANNOTATIONS, title: "Menú de WhatsApp" },
    },
    async (args) => handleMenuWhatsapp(args, ctx),
  );
}
