// =============================================================================
// biller_resolver_nombre
//
// "Facturale a Distribuidora Peres" -> ¿quién es, exactamente?
//
// POR QUÉ ES UNA TOOL Y NO ALGO QUE HACE EL MODELO
//
// Hasta acá, el único que resolvía nombres era el modelo, mirando una lista que
// alguien tenía que haberle pasado antes. Eso falla de dos maneras y las dos son
// caras: elige el cliente equivocado (y el CFE sale a nombre de otra empresa, se
// arregla con una nota de crédito) o no reconoce a uno que existe y lo da de
// alta duplicado, mal cargado, porque el alta dentro de la emisión pide
// dirección y ciudad que nadie tenía a mano.
//
// La regla que el modelo no aplica solo está en `services/resolver.ts`: cuando
// hay dos candidatos parecidos, NO se elige. Se pregunta. Un modelo servicial
// siempre elige.
//
// UNA SOLA TOOL PARA CLIENTES Y PRODUCTOS
//
// Es la misma pregunta ("¿a qué de la lista se refería?") sobre dos listas
// distintas, y la parte delicada —el umbral, el margen, la desambiguación por
// botones— es idéntica. Separarlas duplicaría eso, que es justo lo que no
// conviene tener en dos copias.
//
// DE DÓNDE SALEN LAS LISTAS
//
// De la facturación ya emitida, no de un catálogo: Biller no expone listado de
// clientes ni de productos por GET. Eso tiene una consecuencia buena — solo se
// puede resolver contra cosas que existieron de verdad — y una limitación real:
// lo que nunca se facturó en el período consultado no está. Por eso "ninguno" se
// devuelve como "probablemente es nuevo" y no como "no existe".
//
// Cómo se arman esas listas —y por qué el universo es COMPLETO y no el top 20—
// vive en `services/resolver.ts` (`universoClientes`, `universoProductos`), con
// el resto de la resolución. Es una regla de negocio, no plomería de esta tool:
// decide si el asistente contesta "es un cliente nuevo" o "no lo encontré", y la
// primera dispara un alta. Adentro de una tool era inalcanzable para la emisión
// guiada, un cron o una segunda tool, que solo podían reimplementarla o importar
// una tool desde otra tool.
//
// QUÉ QUEDA ACÁ
//
// El schema (qué se puede pedir y qué se devuelve), la orquestación (traer la
// ventana, decidir cuántos comprobantes se detallan por id, mandar los botones)
// y la forma de la respuesta. Nada que decida a QUIÉN se resuelve.
//
// OJO CON LA CLAVE `nombre`
//
// El nombre del producto se devuelve bajo `nombre` y NUNCA bajo `concepto`.
// `concepto` está en CAMPOS_NO_CONFIABLES, así que la barrera de salida lo
// envolvería en ⟦dato-no-confiable⟧ — y esta salida está pensada JUSTAMENTE para
// volver a entrar en el payload de la emisión, así que las marcas terminarían
// impresas en el CFE. Ver `src/security/untrusted.ts`.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizarTelefono } from "../config.js";
import { traerPorId } from "../biller/traerDetalles.js";
import type { ComprobanteEmitido } from "../biller/types.js";
import { KapsoClient, type InteractivoBotones } from "../kapso/client.js";
import { remitenteSchema } from "../security/remitentes.js";
import { PERIODOS_SOPORTADOS } from "../services/periodo.js";
import { resolverRango, traerVentana } from "../services/ventana.js";
import {
  comoSigue,
  resolver,
  universoClientes,
  universoProductos,
  type ItemResoluble,
  type Resolucion,
} from "../services/resolver.js";
import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorToolResult,
  fechaSchema,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/**
 * Cuántos comprobantes se detallan por id para leer sus `items`.
 *
 * Solo aplica a productos: el listado GET no trae `items`, así que hay que pedir
 * cada comprobante (N+1). 40 es el compromiso — alcanza para cubrir el catálogo
 * que se factura seguido, que es el que alguien va a nombrar mal, y no convierte
 * una pregunta de un renglón en cuarenta requests contra la cuenta de la empresa.
 */
const MAX_DETALLE_PRODUCTOS = 40;

const inputShape = {
  texto: z
    .string()
    .trim()
    .min(1, "texto es requerido: es lo que escribió el usuario.")
    .describe(
      "Lo que escribió el usuario, TAL CUAL, con el error de tipeo incluido si lo tiene " +
        '("Distribuidora Peres", "bolsas de harnia"). No lo corrijas antes de mandarlo: corregirlo ' +
        "es exactamente el trabajo de esta tool, y una corrección tuya sin verificar contra la " +
        "lista real es una adivinanza con cara de dato. También acepta un RUT o cédula, que " +
        "resuelve por coincidencia exacta.",
    ),
  tipo: z
    .enum(["cliente", "producto"])
    .describe(
      "Contra qué lista resolver: 'cliente' (receptores de los comprobantes emitidos) o " +
        "'producto' (conceptos de los ítems facturados).",
    ),
  periodo: z
    .string()
    .optional()
    .default("ultimos_90_dias")
    .describe(
      `Qué facturación mirar para armar la lista. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: ultimos_90_dias. Si el resultado es 'ninguno' y el cliente parece viejo, " +
        "reintentá con anio_actual antes de darlo por nuevo.",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  sucursal: z.string().optional().describe("Filtra a una sola sucursal (ID real de Biller)."),
  enviar: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Con true y resultado ambiguo, manda los candidatos como botones de WhatsApp. Es la forma " +
        "correcta de preguntar: el usuario toca en vez de volver a escribir el nombre que ya " +
        "escribió mal una vez.",
    ),
  destinatario: z
    .string()
    .optional()
    .describe("Número de WhatsApp en formato internacional. Obligatorio si enviar=true."),
  remitente: remitenteSchema,
};

const inputSchema = z.object(inputShape);

const candidatoSchema = z.object({
  // `nombre` y NO `concepto`/`razon_social`: esta salida vuelve a entrar en el
  // payload de emisión. Ver el encabezado.
  nombre: z.string(),
  documento: z.string().nullable(),
  score: z.number(),
  via: z.enum(["documento", "exacto", "parecido"]),
  /** Datos de contexto para que el usuario pueda distinguir dos nombres parecidos. */
  detalle: z.record(z.unknown()),
});

const outputShape = {
  consulta: z.string(),
  tipo: z.enum(["cliente", "producto"]),
  resultado: z.enum(["unico", "ambiguo", "ninguno"]),
  /** El elegido, solo cuando resultado="unico". null en los otros dos casos. */
  elegido: candidatoSchema.nullable(),
  /** Cuando resultado="ambiguo": entre estos hay que elegir. Máximo 3. */
  candidatos: z.array(candidatoSchema),
  /** true cuando NO se puede seguir sin preguntarle al usuario. */
  requiere_confirmacion: z.boolean(),
  como_sigue: z.string(),
  universo: z.object({
    total: z.number(),
    periodo: z.object({ desde: z.string(), hasta: z.string() }),
    comprobantes_analizados: z.number(),
    /** Solo para productos: cuántos comprobantes se detallaron por id. */
    detallados: z.number().nullable(),
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
 * La pregunta de desambiguación como botones.
 *
 * El id lleva el índice y no el nombre: los nombres tienen tildes, comas y más
 * de 20 caracteres, y el id de un botón de WhatsApp no sobrevive a eso. El
 * agente mapea el índice contra `candidatos` de esta misma respuesta.
 */
function construirBotonesCandidatos(
  candidatos: ReadonlyArray<{ item: ItemResoluble }>,
  tipo: "cliente" | "producto",
): InteractivoBotones {
  return {
    tipo: "botones",
    cuerpo:
      (tipo === "cliente"
        ? "Tengo más de un cliente que se parece a eso y no quiero facturarle al que no era 🙂"
        : "Tengo más de un producto que se parece a eso 🙂") + "\n\n¿Cuál es?",
    botones: candidatos.slice(0, 3).map((c, i) => ({
      id: `resolver:${tipo}:${i}`,
      titulo: c.item.nombre.slice(0, 20),
    })),
  };
}

function aSalida(c: { item: ItemResoluble; score: number; via: "documento" | "exacto" | "parecido" }) {
  return {
    nombre: c.item.nombre,
    documento: c.item.documento ?? null,
    score: Math.round(c.score * 100) / 100,
    via: c.via,
    detalle: c.item.extra,
  };
}

export async function handleResolverNombre(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  if (a.enviar && (a.destinatario === undefined || a.destinatario.trim() === "")) {
    return simpleErrorResult(
      "Para mandar los candidatos como botones hace falta 'destinatario' (número de WhatsApp).",
      ctx,
    );
  }

  const resuelto = resolverRango({ periodo: a.periodo, desde: a.desde, hasta: a.hasta });
  if (!resuelto.ok) return simpleErrorResult(resuelto.error, ctx);
  const rango = resuelto.rango;

  const warnings: string[] = [];

  try {
    const config = ctx.getConfig();

    const ventana = await traerVentana(ctx, { rango, sucursal: a.sucursal });
    const filtrados = ventana.comprobantes;
    // Solo los del recorte: a quien preguntó "¿quién es Pérez?" no le dice nada
    // en cuántas ventanas se partió la consulta.
    warnings.push(...ventana.warnings_recorte);

    let universo: ItemResoluble[];
    let detallados: number | null = null;

    if (a.tipo === "cliente") {
      universo = universoClientes(filtrados, rango);
    } else {
      // Los `items` solo vienen consultando por id. Se detallan los de mayor
      // total: es donde está el catálogo que se factura seguido.
      const seleccion = [...filtrados]
        .sort((x, y) => (y.total ?? 0) - (x.total ?? 0))
        .slice(0, MAX_DETALLE_PRODUCTOS);
      // En paralelo acotado, con reintento y con cache: ver
      // `biller/traerDetalles.ts`. El orden es el de `seleccion` (total
      // descendente), no el de llegada.
      const ids = seleccion.filter((c) => c.id !== null).map((c) => c.id!);
      const sinId = seleccion.length - ids.length;
      const traidos = await traerPorId(ctx.getClient(), ids, {
        cache: ctx.getDetallesCache?.(),
      });
      const detalle = ids
        .map((id) => traidos.detalles.get(id))
        .filter((c): c is ComprobanteEmitido => c !== undefined);
      const fallidos = sinId + traidos.fallidos.length;
      detallados = detalle.length;
      universo = universoProductos(detalle);
      if (filtrados.length > MAX_DETALLE_PRODUCTOS) {
        warnings.push(
          `Se miraron los ${MAX_DETALLE_PRODUCTOS} comprobantes de mayor total de ${filtrados.length} ` +
            "del período (Biller no devuelve los ítems en el listado, hay que pedir cada comprobante " +
            "por id). Un producto que solo aparece en facturas chicas puede no estar en la lista: si " +
            'el resultado es "ninguno", no es prueba de que no exista.',
        );
      }
      if (fallidos > 0) {
        warnings.push(`${fallidos} comprobantes no se pudieron detallar y quedaron fuera de la lista.`);
      }
    }

    const resolucion: Resolucion<ItemResoluble> = resolver(a.texto, universo);
    const requiereConfirmacion = resolucion.clase !== "unico";

    // Cuántas veces el resolvedor NO sabe. Un `ambiguo` alto significa que la
    // gente escribe los nombres distinto de como están cargados en Biller, y
    // eso se arregla con datos, no con código. Se cuenta la CLASE y el TIPO
    // —dos vocabularios cerrados—, nunca el texto buscado ni el nombre hallado.
    ctx.metricas.contar("resolver.consulta", { tipo: a.tipo, clase: resolucion.clase });

    if (resolucion.clase === "unico" && resolucion.elegido.via === "parecido") {
      warnings.push(
        `"${a.texto}" no coincide exactamente con "${resolucion.elegido.item.nombre}": se eligió por ` +
          "parecido. Nombralo en tu respuesta para que el usuario pueda corregirte ANTES de emitir, " +
          "no después.",
      );
    }
    if (resolucion.clase === "ambiguo") {
      warnings.push(
        `"${a.texto}" se parece a ${resolucion.candidatos.length} de la lista. NO elijas vos: ` +
          "preguntá cuál es.",
      );
    }

    // --- Envío de los botones (solo si hay algo que preguntar) --------------
    let realizado = false;
    let motivo: string | null = null;
    let messageId: string | null = null;
    let sufijo: string | null = null;

    if (!a.enviar) {
      motivo = "No se solicitó envío (enviar=false).";
    } else if (resolucion.clase !== "ambiguo") {
      motivo =
        "No hay nada que preguntar: el resultado no es ambiguo. Mandar botones acá sería pedirle al " +
        "usuario que confirme algo que no está en duda.";
    } else if (config.kapso === undefined) {
      motivo = "Kapso no está configurado: falta KAPSO_API_KEY.";
      warnings.push(motivo);
    } else {
      const destino = normalizarTelefono(a.destinatario!);
      sufijo = destino.slice(-4);
      const kapso = new KapsoClient(config.kapso);
      const res = await kapso.enviarInteractivo(
        destino,
        construirBotonesCandidatos(resolucion.candidatos, a.tipo),
        { actorIdentity: a.remitente, operation: "resolucion" },
      );
      realizado = true;
      messageId = res.message_id;
    }

    return jsonResult({
      consulta: a.texto,
      tipo: a.tipo,
      resultado: resolucion.clase,
      elegido: resolucion.clase === "unico" ? aSalida(resolucion.elegido) : null,
      candidatos:
        resolucion.clase === "ambiguo"
          ? resolucion.candidatos.map(aSalida)
          : resolucion.clase === "unico"
            ? resolucion.alternativas.map(aSalida)
            : [],
      requiere_confirmacion: requiereConfirmacion,
      como_sigue: comoSigue(resolucion, a.texto),
      universo: {
        total: universo.length,
        periodo: { desde: rango.desde, hasta: rango.hasta },
        comprobantes_analizados: filtrados.length,
        detallados,
      },
      envio: {
        solicitado: a.enviar,
        realizado,
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

export function registerResolverNombre(server: McpServer, ctx: ToolContext): void {
  const puedeEnviar = (() => {
    try {
      return ctx.getConfig().kapso !== undefined;
    } catch {
      return false;
    }
  })();

  server.registerTool(
    "biller_resolver_nombre",
    {
      title: "Resolver un nombre contra la facturación real",
      description:
        "Convierte el nombre que escribió el usuario —con errores de tipeo, abreviado, sin el " +
        '"S.R.L."— en un cliente o un producto REAL de esta empresa. Llamala SIEMPRE antes de ' +
        "emitirle a alguien nombrado por su nombre, antes de dar de alta un cliente (para no " +
        "duplicarlo) y antes de cargar un ítem por su descripción. Devuelve uno solo cuando está " +
        "claro, varios candidatos cuando hay duda —y ahí HAY QUE PREGUNTAR, no elegir— o ninguno, " +
        "que significa que probablemente sea nuevo. Acepta también un RUT o cédula, que resuelve " +
        "por coincidencia exacta.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: puedeEnviar
        ? { ...WRITE_ANNOTATIONS, destructiveHint: false, title: "Resolver un nombre" }
        : { ...READ_ONLY_ANNOTATIONS, title: "Resolver un nombre" },
    },
    async (args) => handleResolverNombre(args, ctx),
  );
}
