// =============================================================================
// biller_ranking_clientes
//
// Quién factura más, quién es nuevo, quién dejó de comprar y qué tan
// concentrada está la cartera. Todo derivado del campo `cliente` de los
// comprobantes emitidos: Biller no expone listado de clientes.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterEmitidos } from "../services/comprobanteFilters.js";
import { extractClienteRut } from "../biller/normalize.js";
import {
  PERIODOS_SOPORTADOS,
  aIso,
  consultarPorPeriodo,
  resolverPeriodo,
  type RangoFechas,
} from "../services/periodo.js";
import { DIAS_DORMIDO, rankingClientes } from "../services/rankingClientes.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  fechaSchema,
  jsonResult,
  simpleErrorResult,
  validationErrorResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

const inputShape = {
  periodo: z
    .string()
    .optional()
    .default("ultimos_90_dias")
    .describe(
      `Período por fecha de EMISIÓN. Acepta: ${PERIODOS_SOPORTADOS.join(", ")}. ` +
        "Default: ultimos_90_dias (un período corto hace que casi nadie parezca 'dormido').",
    ),
  desde: fechaSchema.optional().describe("Inicio del período (aaaa-mm-dd). Alternativa a 'periodo'."),
  hasta: fechaSchema.optional().describe("Fin del período (aaaa-mm-dd), inclusive."),
  moneda: z
    .string()
    .optional()
    .describe("Moneda para ordenar y calcular porcentajes (ej. UYU, USD). Default: la de mayor facturación."),
  limite: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(20)
    .describe("Cuántos clientes devolver, del que más factura al que menos."),
  dias_dormido: z
    .number()
    .int()
    .positive()
    .max(3650)
    .optional()
    .default(DIAS_DORMIDO)
    .describe(`Días sin comprar para considerar a un cliente dormido. Default: ${DIAS_DORMIDO}.`),
  solo_dormidos: z
    .boolean()
    .optional()
    .default(false)
    .describe("Si es true, devuelve solo los clientes dormidos (lista de recuperación)."),
  detectar_nuevos: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Averigua cuáles clientes son NUEVOS de verdad, consultando también los `dias_antiguedad` " +
        "anteriores al período. Cuesta una consulta más (cacheada), así que está apagado por " +
        "defecto: sin esto, `es_nuevo` viene en null en vez de adivinar. Se prende solo cuando " +
        "pedís solo_nuevos.",
    ),
  dias_antiguedad: z
    .number()
    .int()
    .positive()
    .optional()
    .default(365)
    .describe(
      'Cuánto se mira hacia atrás para decidir si un cliente es nuevo. "Nuevo" siempre es relativo ' +
        "a un horizonte: con 365, nuevo = no te compró en el último año.",
    ),
  solo_nuevos: z
    .boolean()
    .optional()
    .default(false)
    .describe("Si es true, devuelve solo los clientes cuya primera compra cae en el período."),
  solo_atrasados: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Si es true, devuelve solo los clientes que llevan más del doble de SU PROPIO intervalo de " +
        "compra sin aparecer, y que todavía no llegan al corte de 'dormido'. Es la lista para " +
        "llamar hoy: cuando figuren como dormidos ya se fueron.",
    ),
  umbral_nc_pct: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe("Ratio de notas de crédito (%) a partir del cual marcar un cliente. Default: 15."),
  solo_aceptados: z
    .boolean()
    .optional()
    .default(true)
    .describe('Contar solo comprobantes "Aceptado DGI" (criterio que usa Biller). Default: true.'),
  sucursal: z.string().optional().describe("Filtra a una sola sucursal (ID real de Biller)."),
  ventana_dias: z
    .number()
    .int()
    .positive()
    .max(90)
    .optional()
    .describe("Tamaño de cada ventana de consulta en días (default 7). Bajalo si la API devuelve 500."),
};

export const rankingClientesInputSchema = z.object(inputShape);

const clienteSchema = z.object({
  rut: z.string().nullable(),
  nombre: z.string().nullable(),
  facturado_por_moneda: z.record(z.number()),
  comprobantes: z.number(),
  notas_credito_por_moneda: z.record(z.number()),
  cantidad_notas_credito: z.number(),
  ratio_notas_credito_pct: z.number().nullable(),
  nc_anomalas: z.boolean(),
  primera_compra: z.string().nullable(),
  ultima_compra: z.string().nullable(),
  dias_desde_ultima_compra: z.number().nullable(),
  ticket_promedio: z.number().nullable(),
  dias_con_compra: z.number(),
  dias_entre_compras_promedio: z.number().nullable(),
  atrasado_vs_su_frecuencia: z.boolean(),
  participacion_pct: z.number().nullable(),
  /** null = no se miró hacia atrás, así que no se sabe. Ver `detectar_nuevos`. */
  es_nuevo: z.boolean().nullable(),
  esta_dormido: z.boolean(),
});

const outputShape = {
  periodo: z.object({ desde: z.string(), hasta: z.string(), criterio: z.literal("fecha_emision") }),
  fuente: z.literal("biller:/v2/comprobantes/obtener"),
  clientes: z.array(clienteSchema),
  moneda_orden: z.string(),
  monedas_presentes: z.array(z.string()),
  concentracion: z
    .object({
      moneda: z.string(),
      top_1_pct: z.number(),
      top_3_pct: z.number(),
      top_5_pct: z.number(),
      hhi: z.number(),
      interpretacion: z.string(),
      clientes_hasta_50_pct: z.number(),
      clientes_totales: z.number(),
    })
    .nullable(),
  nuevos: z.number(),
  /** Cuántos días hacia atrás se miró para decidir "nuevo". null = no se miró. */
  antiguedad_mirada_dias: z.number().nullable(),
  dormidos: z.number(),
  atrasados_vs_su_frecuencia: z.number(),
  total_facturado_por_moneda: z.record(z.number()),
  clientes_totales: z.number(),
  comprobantes_analizados: z.number(),
  filtro_aplicado: z.string(),
  ventanas_consultadas: z.number(),
  no_convertir_moneda: z.literal(true),
  warnings: z.array(z.string()),
};

export async function handleRankingClientes(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = rankingClientesInputSchema.safeParse(args);
  if (!parsed.success) return validationErrorResult(parsed.error, ctx);
  const a = parsed.data;

  const filtros = [a.solo_dormidos, a.solo_nuevos, a.solo_atrasados].filter(Boolean).length;
  if (filtros > 1) {
    return simpleErrorResult(
      "solo_dormidos, solo_nuevos y solo_atrasados son excluyentes entre sí: son tres segmentos " +
        "distintos de la cartera (un cliente nuevo del período no puede estar dormido, y el " +
        "atraso relativo se define justamente como todavía-no-dormido). Pedí uno por vez.",
      ctx,
    );
  }

  let rango: RangoFechas;
  if (a.desde !== undefined && a.hasta !== undefined) {
    rango = { desde: a.desde, hasta: a.hasta };
  } else {
    const resuelto = resolverPeriodo(a.periodo);
    if (resuelto === null) {
      return simpleErrorResult(
        `No se pudo interpretar el período "${a.periodo}". Valores aceptados: ${PERIODOS_SOPORTADOS.join(", ")}.`,
        ctx,
      );
    }
    rango = resuelto;
  }

  if (rango.desde > rango.hasta) {
    return simpleErrorResult(
      `El período está invertido: 'desde' (${rango.desde}) es posterior a 'hasta' (${rango.hasta}).`,
      ctx,
    );
  }

  try {
    const config = ctx.getConfig();
    const client = ctx.getClient();
    const sucursal = a.sucursal ?? config.defaultSucursalId;

    const consulta = await consultarPorPeriodo(client, rango, {
      sucursal,
      ventanaDias: a.ventana_dias,
    });
    const filtered = filterEmitidos(consulta.comprobantes, {
      emitidas_desde: rango.desde,
      emitidas_hasta: rango.hasta,
    });

    // --- ¿Quién ya había comprado ANTES? -------------------------------------
    //
    // Sin esto, "es nuevo" no se puede contestar. La versión anterior lo
    // "contestaba" con `primera_compra >= desde`, sobre una lista YA filtrada al
    // período: verdadero siempre. Todos los clientes salían nuevos y "ganaste N
    // clientes nuevos" era, literalmente, el conteo de clientes.
    //
    // Cuesta una consulta más, así que es opt-in: se prende sola cuando piden
    // `solo_nuevos` —donde el dato ES la pregunta— y si no, `es_nuevo` viene en
    // null. Cae en el mismo cache de ventanas que todo lo demás, así que
    // preguntar dos veces en una conversación no cuesta dos veces.
    let rutsPrevios: Set<string> | undefined;
    let horizonte: number | null = null;
    const avisosNuevos: string[] = [];
    if (a.detectar_nuevos || a.solo_nuevos) {
      const antesDesde = aIso(new Date(Date.parse(`${rango.desde}T00:00:00Z`) - a.dias_antiguedad * 86_400_000));
      const antesHasta = aIso(new Date(Date.parse(`${rango.desde}T00:00:00Z`) - 86_400_000));
      const previa = await consultarPorPeriodo(client, { desde: antesDesde, hasta: antesHasta }, {
        sucursal,
        ventanaDias: a.ventana_dias,
      });
      const previos = filterEmitidos(previa.comprobantes, {
        emitidas_desde: antesDesde,
        emitidas_hasta: antesHasta,
      });
      rutsPrevios = new Set<string>();
      // `extractClienteRut`, el MISMO que usa el servicio para agrupar. Si acá
      // se sacara el RUT de otra forma, los dos conjuntos no se cruzarían y
      // todos volverían a salir nuevos — el bug de vuelta, por otra puerta.
      for (const c of previos.list) {
        const rut = extractClienteRut(c.cliente);
        if (rut !== null) rutsPrevios.add(rut);
      }
      horizonte = a.dias_antiguedad;
      avisosNuevos.push(
        `"Nuevo" acá significa: no te compró en los ${a.dias_antiguedad} días anteriores al período. ` +
          "No significa que nunca te haya comprado — para eso habría que mirar toda la historia.",
      );
    } else {
      avisosNuevos.push(
        "`es_nuevo` viene en null: para saber si un cliente es nuevo hay que mirar ANTES del " +
          "período, y eso es una consulta más. Pedila con detectar_nuevos=true.",
      );
    }

    // El límite se aplica DESPUÉS del filtro por segmento: pedir "los 20
    // dormidos" y recibir "los dormidos que hay entre los 20 que más facturan"
    // es una respuesta distinta a la pregunta.
    const resultado = rankingClientes(filtered.list, {
      desde: rango.desde,
      hasta: rango.hasta,
      ...(rutsPrevios !== undefined ? { ruts_previos: rutsPrevios } : {}),
      moneda: a.moneda,
      solo_aceptados: a.solo_aceptados,
      dias_dormido: a.dias_dormido,
      umbral_nc_pct: a.umbral_nc_pct,
      limite: filtros > 0 ? Number.MAX_SAFE_INTEGER : a.limite,
    });

    let clientes = resultado.clientes;
    let filtro = "todos";
    if (a.solo_dormidos) {
      clientes = clientes.filter((c) => c.esta_dormido).slice(0, a.limite);
      filtro = `dormidos (>${a.dias_dormido} días sin comprar)`;
    } else if (a.solo_nuevos) {
      clientes = clientes.filter((c) => c.es_nuevo === true).slice(0, a.limite);
      filtro = "nuevos en el período";
    } else if (a.solo_atrasados) {
      clientes = clientes
        .filter((c) => c.atrasado_vs_su_frecuencia && !c.esta_dormido)
        .slice(0, a.limite);
      filtro = "atrasados contra su propia frecuencia (todavía no dormidos)";
    }

    return jsonResult({
      periodo: { desde: rango.desde, hasta: rango.hasta, criterio: "fecha_emision" },
      fuente: "biller:/v2/comprobantes/obtener",
      clientes,
      moneda_orden: resultado.moneda_orden,
      monedas_presentes: resultado.monedas_presentes,
      concentracion: resultado.concentracion,
      nuevos: resultado.nuevos,
      antiguedad_mirada_dias: horizonte,
      dormidos: resultado.dormidos,
      atrasados_vs_su_frecuencia: resultado.atrasados_vs_su_frecuencia,
      total_facturado_por_moneda: resultado.total_facturado_por_moneda,
      clientes_totales: resultado.clientes_totales,
      comprobantes_analizados: resultado.comprobantes_analizados,
      filtro_aplicado: filtro,
      ventanas_consultadas: consulta.ventanas,
      no_convertir_moneda: true,
      warnings: [...consulta.warnings, ...filtered.warnings, ...resultado.warnings, ...avisosNuevos],
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerRankingClientes(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_ranking_clientes",
    {
      title: "Ranking de clientes",
      description:
        "Quién factura más, quién compró por primera vez, quién dejó de comprar y qué tan concentrada " +
        "está la cartera (índice HHI y participación del top 1/3/5). Trae también cada cuánto compra " +
        "cada cliente y marca a los que llevan más del doble de SU propio intervalo sin aparecer " +
        "(solo_atrasados), que es la señal que llega antes que 'dormido'. La cartera se DERIVA de los " +
        "comprobantes emitidos porque Biller no expone listado de clientes. Las notas de crédito " +
        "restan y los recibos no cuentan como facturación. NO convierte monedas.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Ranking de clientes" },
    },
    async (args) => handleRankingClientes(args, ctx),
  );
}
