// =============================================================================
// biller_catalogo_datos
//
// La tool más subestimada del set: le dice al modelo QUÉ SE PUEDE PREGUNTAR y,
// más importante, QUÉ NO.
//
// Sin esto, el modelo intenta contestar "¿quién me debe plata?" con los datos
// que tiene y produce un número que parece una respuesta y no lo es. Con esto,
// contesta "eso no se puede saber con la API actual, y este es el motivo" — que
// es la respuesta correcta y la que construye confianza.
//
// También es lo que alimenta las preguntas sugeridas de cualquier interfaz sin
// tener que hardcodearlas: la lista sale de acá, no de la UI.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegisteredToolNames } from "./register.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorToolResult,
  jsonResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

type Disponibilidad = "disponible" | "parcial" | "no_disponible";

interface CapacidadCatalogo {
  pregunta: string;
  disponibilidad: Disponibilidad;
  tool: string | null;
  fuente: string;
  /** Qué NO cubre. Vacío solo si de verdad no hay caveat. */
  limitaciones: string[];
}

/**
 * El catálogo es una constante, no algo derivado: describe lo que la API de
 * Biller permite responder, que cambia solo cuando cambia la API. Tenerlo
 * escrito hace que las limitaciones sean revisables en un diff.
 */
const CAPACIDADES: CapacidadCatalogo[] = [
  {
    pregunta: "¿Cuánto facturé en un período? ¿Por sucursal, por moneda, por tipo de comprobante?",
    disponibilidad: "disponible",
    tool: "biller_resumen_facturacion_periodo",
    fuente: "GET /v2/comprobantes/obtener",
    limitaciones: [
      'Cuenta solo comprobantes "Aceptado DGI" por defecto (criterio con el que Biller muestra sus números).',
      "No convierte monedas: los totales van separados por moneda.",
    ],
  },
  {
    pregunta: "¿Qué facturas vencen esta semana? ¿Cuánto tengo vencido y hace cuánto?",
    disponibilidad: "disponible",
    tool: "biller_vencimientos",
    fuente: "GET /v2/comprobantes/obtener (campo fecha_vencimiento)",
    limitaciones: [
      "Es el DEVENGADO, no el cobrado: una factura vencida puede estar paga sin que se sepa acá.",
    ],
  },
  {
    pregunta: "¿Qué me rechazó DGI? ¿Me estoy quedando sin CAE?",
    disponibilidad: "disponible",
    tool: "biller_alertas_operativas",
    fuente: "GET /v2/comprobantes/obtener (campos estado y cae)",
    limitaciones: [
      "Los CAE disponibles son una estimación optimista: solo se ve el período consultado.",
    ],
  },
  {
    pregunta: "¿Quiénes son mis mejores clientes? ¿Quién dejó de comprarme? ¿Estoy muy concentrado?",
    disponibilidad: "disponible",
    tool: "biller_ranking_clientes",
    fuente: "GET /v2/comprobantes/obtener (campo cliente)",
    limitaciones: [
      "La cartera se DERIVA de la facturación: Biller no expone listado de clientes.",
      "Las ventas sin receptor (e-Ticket de mostrador) se agrupan aparte y no cuentan para la concentración.",
    ],
  },
  {
    pregunta: "¿Cómo le va a cada sucursal? ¿Cuál está perdiendo peso?",
    disponibilidad: "disponible",
    tool: "biller_ranking_sucursales",
    fuente: "GET /v2/comprobantes/obtener (campo sucursal), dos períodos",
    limitaciones: [
      "Los nombres de las sucursales salen de BILLER_SUCURSALES_JSON: Biller no expone un endpoint " +
        'de sucursales. Sin ese mapa el ranking dice "Sucursal 6" en vez de "Pocitos".',
      "Los comprobantes sin sucursal se agrupan aparte y NO se suman a ninguna sucursal real.",
    ],
  },
  {
    pregunta: "Los clientes que gané en marzo, ¿siguen comprando? ¿Cuánto retengo?",
    disponibilidad: "parcial",
    tool: "biller_cohortes_clientes",
    fuente: "GET /v2/comprobantes/obtener (primera fecha_emision por RUT)",
    limitaciones: [
      "El 'alta' es la PRIMERA COMPRA DENTRO DEL RANGO consultado: Biller no expone fecha de alta " +
        "de clientes. Por eso las primeras cohortes vienen infladas con clientes preexistentes y " +
        "se marcan 'posible_contaminada' (quedan fuera de la curva promedio).",
      "Las ventas sin receptor no forman cohorte: juntarían personas distintas.",
    ],
  },
  {
    pregunta: "¿Cuánto me da IVA este mes?",
    disponibilidad: "no_disponible",
    tool: null,
    fuente: "implementado pero DESHABILITADO por defecto (BILLER_ENABLE_IVA_ESTIMADO)",
    limitaciones: [
      "La estimación existe (biller_posicion_iva) pero NO se registra salvo que se habilite a mano.",
      "Motivo: el número se parece a una declaración jurada sin serlo. No contempla importaciones, " +
        "servicios del exterior, prorrata por operaciones exentas ni ajustes contables.",
      "Si el usuario pregunta esto, decile que el dato lo tiene que dar su contador, y que existe " +
        "una estimación de gestión que se puede habilitar asumiendo esas limitaciones.",
    ],
  },
  {
    pregunta: "¿Cuánto le compré a cada proveedor?",
    disponibilidad: "disponible",
    tool: "biller_compras_proveedores",
    fuente: "GET /v2/comprobantes/recibidos/obtener, agrupado por proveedor",
    limitaciones: ["Es el devengado (lo facturado por el proveedor), no lo efectivamente pagado."],
  },
  {
    pregunta: "¿Quién me debe plata? ¿Cuál es mi aging real de cobranzas?",
    disponibilidad: "disponible",
    tool: "biller_cuenta_corriente",
    fuente: "derivado de comprobantes emitidos + recibos (CFE con indicador_cobranza_propia = 1)",
    limitaciones: [
      // El caveat anterior decía que los recibos no se podían leer. Era falso, y
      // el costo fue silencioso: se mandaba en cada respuesta de cobranzas y
      // dejaba un número correcto con cara de estimación.
      "La imputación es EXACTA cuando el recibo trae los comprobantes que cancela (viajan en " +
        "items[].concepto, con forma '<tipo> <SERIE>-<NUMERO>'); cae a FIFO solo si no vienen. " +
        "La respuesta declara cuál usó en 'estrategia'.",
      "Un cobro hecho fuera de Biller (transferencia sin recibo emitido) es invisible acá.",
    ],
  },
  {
    pregunta: "¿Qué productos vendí más? ¿A qué precio los estoy vendiendo?",
    disponibilidad: "parcial",
    tool: "biller_ranking_productos",
    fuente: "GET /v2/comprobantes/obtener por id (el detalle de items)",
    limitaciones: [
      "El array `items` SOLO viene consultando un comprobante por `id`: es un N+1, una llamada " +
        "HTTP por comprobante. Se prioriza por importe y se recorta, así que el ranking cubre una " +
        "PARTE del período: la respuesta dice cuánta en 'cobertura_importe_pct'.",
      "Para un período completo sin recorte hace falta un store local sincronizado (Fase 1 del plan).",
    ],
  },
  {
    pregunta: "¿A qué cliente le hago más descuento?",
    disponibilidad: "no_disponible",
    tool: null,
    fuente: "requiere el detalle de items de TODOS los comprobantes",
    limitaciones: [
      "Mismo N+1 que el ranking de productos, pero acá un recorte invalida la respuesta: el " +
        "descuento grande puede estar justo en el comprobante que no se trajo.",
    ],
  },
  {
    pregunta: "¿Cuál es mi margen por producto?",
    disponibilidad: "no_disponible",
    tool: null,
    fuente: "no existe en Biller",
    limitaciones: [
      "Biller NO tiene campo de costo en ningún endpoint, ni de lectura ni de escritura.",
      "Requiere importar costos desde afuera (CSV/planilla). Sin eso, cualquier margen es adivinanza.",
    ],
  },
  {
    pregunta: "¿Cuánto tengo que pagar yo a mis proveedores (cuentas por pagar)?",
    disponibilidad: "no_disponible",
    tool: null,
    fuente: "los recibidos dan el devengado, no el pagado",
    limitaciones: ["Requiere un registro de pagos propios que Biller no expone."],
  },
];

const inputShape = {
  incluir_no_disponibles: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Incluir las preguntas que NO se pueden contestar y por qué. Default: true — saber qué no " +
        "se puede saber es la mitad del valor de esta tool.",
    ),
};

export const catalogoDatosInputSchema = z.object(inputShape);

const outputShape = {
  capacidades: z.array(
    z.object({
      pregunta: z.string(),
      disponibilidad: z.enum(["disponible", "parcial", "no_disponible"]),
      tool: z.string().nullable(),
      fuente: z.string(),
      limitaciones: z.array(z.string()),
    }),
  ),
  tools_registradas: z.array(z.string()),
  modo_operativo: z.string(),
  escritura_habilitada: z.boolean(),
  ambiente: z.string(),
  canal_whatsapp: z.object({ configurado: z.boolean(), destinatarios_permitidos: z.number() }),
  preguntas_sugeridas: z.array(z.string()),
  conteo: z.object({ disponible: z.number(), parcial: z.number(), no_disponible: z.number() }),
  advertencia_general: z.string(),
};

export function handleCatalogoDatos(args: unknown, ctx: ToolContext): ToolResult {
  const parsed = catalogoDatosInputSchema.safeParse(args);
  const incluirNoDisponibles = parsed.success ? parsed.data.incluir_no_disponibles : true;

  try {
    const config = ctx.getConfig();
    const capacidades = incluirNoDisponibles
      ? CAPACIDADES
      : CAPACIDADES.filter((c) => c.disponibilidad !== "no_disponible");

    return jsonResult({
      capacidades,
      tools_registradas: [
        ...getRegisteredToolNames(config.capabilityMode, {
          enableIvaEstimado: config.enableIvaEstimado,
        }),
      ],
      modo_operativo: config.capabilityMode,
      escritura_habilitada: config.writeEnabled,
      ambiente: config.environment,
      canal_whatsapp: {
        configurado: config.kapso !== undefined,
        destinatarios_permitidos: config.kapso?.destinatariosPermitidos.length ?? 0,
      },
      // Solo se sugiere lo que de verdad se puede contestar bien.
      preguntas_sugeridas: CAPACIDADES.filter((c) => c.disponibilidad === "disponible").map(
        (c) => c.pregunta,
      ),
      conteo: {
        disponible: CAPACIDADES.filter((c) => c.disponibilidad === "disponible").length,
        parcial: CAPACIDADES.filter((c) => c.disponibilidad === "parcial").length,
        no_disponible: CAPACIDADES.filter((c) => c.disponibilidad === "no_disponible").length,
      },
      advertencia_general:
        "Si una pregunta del usuario cae en 'no_disponible', decíselo con el motivo en vez de " +
        "aproximar con los datos que hay. Un número que parece una respuesta y no lo es hace más " +
        "daño que un 'esto todavía no se puede saber'.",
    });
  } catch (err) {
    return errorToolResult(err, ctx);
  }
}

export function registerCatalogoDatos(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "biller_catalogo_datos",
    {
      title: "Catálogo de datos disponibles",
      description:
        "Declara qué preguntas se pueden contestar con los datos de Biller, con qué tool, desde qué " +
        "endpoint y con qué limitaciones — incluyendo las que NO se pueden contestar y por qué. " +
        "Consultala antes de responder algo sobre cobranzas, márgenes, productos o costos: son " +
        "justamente las áreas donde la API tiene huecos y donde es fácil dar un número equivocado.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: "Catálogo de datos disponibles" },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async (args) => handleCatalogoDatos(args, ctx),
  );
}
