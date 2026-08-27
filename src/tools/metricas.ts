// =============================================================================
// biller_metricas
//
// Cómo viene funcionando ESTE proceso: qué se usa, qué falla y —lo que motivó
// todo el módulo— qué proporción de mensajes el asistente no entiende.
//
// NO ES UNA TOOL DE NEGOCIO. No contesta nada sobre la facturación de la
// empresa: no toca la API de Biller, no lee un comprobante y no devuelve un
// importe. Todo lo que sale de acá son conteos de eventos propios.
//
// LO QUE MIDE Y CONTRA QUÉ SE COMPARA
//
// Las tres preguntas que el proyecto no podía contestar, y ahora sí:
//   · `enrutador.mensaje{via=desconocido}` sobre el total → cuánto NO se entiende;
//   · `emision.paso{paso=...}` → el embudo, y en qué pregunta se abandona;
//   · `resolver.consulta{clase=ambiguo}` → cuántas veces hay que repreguntar.
//
// ALCANCE, dicho para que nadie lea el número equivocado: los contadores son de
// ESTE PROCESO y desde que arrancó. En stdio eso es la sesión; en el server HTTP
// es desde el último deploy; en Vercel es casi nada, porque el proceso se muere
// entre invocaciones. Por eso cada evento además se escribe como una línea de
// log: para serverless, la fuente de verdad es el agregador de logs, no esto.
// La respuesta lo dice en `alcance` en vez de dejar que se asuma.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS, jsonResult, type ToolContext, type ToolResult } from "./shared.js";

const inputShape = {
  reiniciar: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Pone los contadores en cero DESPUÉS de leerlos. Sirve para medir una ventana concreta " +
        "(ej. una demo). Ojo: lo borrado no se recupera.",
    ),
};

export const metricasInputSchema = z.object(inputShape);

const outputShape = {
  alcance: z.string(),
  desde: z.string(),
  total_eventos: z.number(),
  muestras: z.array(
    z.object({
      nombre: z.string(),
      etiquetas: z.record(z.string()),
      valor: z.number(),
    }),
  ),
  /** Los tres números que resumen la salud del asistente. null si no hubo tráfico. */
  resumen: z.object({
    mensajes_enrutados: z.number(),
    no_entendidos_pct: z.number().nullable(),
    resoluciones_ambiguas_pct: z.number().nullable(),
    tools_con_error: z.array(z.object({ tool: z.string(), errores: z.number() })),
  }),
  desbordadas: z.array(z.string()),
  lectura: z.string(),
  reiniciado: z.boolean(),
};

/** Suma las muestras de una métrica, opcionalmente filtrando por una etiqueta. */
function sumar(
  muestras: Array<{ nombre: string; etiquetas: Record<string, string>; valor: number }>,
  nombre: string,
  filtro?: (e: Record<string, string>) => boolean,
): number {
  return muestras
    .filter((m) => m.nombre === nombre && (filtro === undefined || filtro(m.etiquetas)))
    .reduce((acc, m) => acc + m.valor, 0);
}

export function handleMetricas(args: unknown, ctx: ToolContext): ToolResult {
  const parsed = metricasInputSchema.safeParse(args);
  const reiniciar = parsed.success ? parsed.data.reiniciar : false;

  const snap = ctx.metricas.instantanea();
  const m = snap.muestras;

  const enrutados = sumar(m, "enrutador.mensaje");
  const noEntendidos = sumar(m, "enrutador.mensaje", (e) => e.via === "desconocido");
  const resoluciones = sumar(m, "resolver.consulta");
  const ambiguas = sumar(m, "resolver.consulta", (e) => e.clase === "ambiguo");

  const pct = (parte: number, total: number): number | null =>
    total === 0 ? null : Math.round((parte / total) * 1000) / 10;

  const noEntendidosPct = pct(noEntendidos, enrutados);
  const ambiguasPct = pct(ambiguas, resoluciones);

  // Errores por tool, de mayor a menor. Es el otro número que se mira primero.
  const errores = new Map<string, number>();
  for (const muestra of m) {
    if (muestra.nombre !== "tool.invocacion") continue;
    if (muestra.etiquetas.resultado !== "error" && muestra.etiquetas.resultado !== "excepcion") {
      continue;
    }
    const tool = muestra.etiquetas.tool ?? "(sin nombre)";
    errores.set(tool, (errores.get(tool) ?? 0) + muestra.valor);
  }
  const toolsConError = [...errores.entries()]
    .map(([tool, e]) => ({ tool, errores: e }))
    .sort((a, b) => b.errores - a.errores);

  const lineas: string[] = [];
  if (enrutados === 0) {
    lineas.push(
      "Todavía no pasó ningún mensaje por el enrutador en este proceso, así que no hay nada que " +
        "leer sobre si el asistente entiende o no.",
    );
  } else {
    lineas.push(
      `De ${enrutados} mensaje(s), el ${noEntendidosPct}% cayó en "no entendí".` +
        (noEntendidosPct !== null && noEntendidosPct > 20
          ? " Es alto: por encima del 20% la gente empieza a dejar de escribir."
          : ""),
    );
  }
  if (resoluciones > 0) {
    lineas.push(
      `El resolvedor de nombres contestó "ambiguo" el ${ambiguasPct}% de las veces. Ambiguo no es ` +
        "un error —preguntar es lo correcto— pero si es alto, suele significar que los nombres " +
        "cargados en Biller no se parecen a como los dice la gente.",
    );
  }
  if (toolsConError.length > 0) {
    const peor = toolsConError[0]!;
    lineas.push(`La tool con más fallas es ${peor.tool} (${peor.errores}).`);
  }
  if (snap.desbordadas.length > 0) {
    lineas.push(
      `⚠️ ${snap.desbordadas.join(", ")} tocó el techo de cardinalidad: alguna etiqueta está ` +
        "tomando demasiados valores distintos. Es un bug de instrumentación, no un dato.",
    );
  }

  const salida = {
    alcance:
      "Conteos de ESTE proceso desde 'desde'. En stdio es la sesión; en HTTP, desde el último " +
      "reinicio; en serverless (Vercel) casi nada, porque el proceso se muere entre invocaciones " +
      "— ahí la fuente de verdad son las líneas 'metrica' del log. No incluye datos de facturación.",
    desde: snap.desde,
    total_eventos: snap.total_eventos,
    muestras: m,
    resumen: {
      mensajes_enrutados: enrutados,
      no_entendidos_pct: noEntendidosPct,
      resoluciones_ambiguas_pct: ambiguasPct,
      tools_con_error: toolsConError,
    },
    desbordadas: snap.desbordadas,
    lectura: lineas.length === 0 ? "Sin actividad registrada todavía." : lineas.join(" "),
    reiniciado: reiniciar,
  };

  if (reiniciar) ctx.metricas.reiniciar();

  return jsonResult(salida);
}

export function registerMetricas(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_metricas",
    {
      title: "Métricas de uso del asistente",
      description:
        "Cómo viene funcionando el asistente: qué tools se usan, cuáles fallan, qué proporción de " +
        "mensajes cae en 'no entendí' y en qué paso se abandonan las emisiones. NO consulta la API " +
        "de Biller ni devuelve ningún dato de facturación: son conteos de eventos propios. Los " +
        "contadores son de este proceso; en serverless usá las líneas 'metrica' del log.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Métricas de uso del asistente" },
    },
    async (args) => handleMetricas(args, ctx),
  );
}
