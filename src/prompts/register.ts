// =============================================================================
// Prompts MCP: rutinas guiadas.
//
// La capacidad más subestimada del protocolo. Hoy "hacer el cierre de mes" son
// seis invocaciones que el usuario tiene que saber encadenar en el orden
// correcto. Como prompt es UNA cosa que el host ofrece en un menú.
//
// Es la diferencia entre entregar una caja de herramientas y entregar un
// producto. El server ya sabe cuál es el orden correcto de las preguntas y
// dónde están las trampas — eso es conocimiento que debe vivir acá, no en la
// cabeza del usuario ni en la suerte del modelo.
//
// Los prompts NO ejecutan nada: devuelven el guion. Quien decide y ejecuta
// sigue siendo el modelo con el usuario mirando.
// =============================================================================

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function mensaje(texto: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: texto } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "cierre_de_mes",
    {
      title: "Cierre de mes",
      description:
        "Rutina completa de cierre: facturación del mes, comparación con el anterior, rechazos DGI " +
        "pendientes, estimación de IVA y estado de cobranzas.",
      argsSchema: {
        mes: z
          .string()
          .optional()
          .describe('Mes a cerrar en formato aaaa-mm (ej. 2026-06). Si se omite, el mes pasado.'),
      },
    },
    ({ mes }) => {
      const periodo = mes ?? "mes_pasado";
      return mensaje(
        `Hacé el cierre de ${periodo === "mes_pasado" ? "el mes pasado" : periodo}. Seguí este orden:\n\n` +
          `1. biller_resumen_facturacion_periodo con periodo="${periodo}" — cuánto se facturó, por moneda.\n` +
          `2. Repetí el resumen para el mes ANTERIOR a ese y compará: ¿subió o bajó, y cuánto?\n` +
          `3. biller_alertas_operativas con el mismo período — ¿quedó algo rechazado por DGI? ` +
          `Eso es facturación SIN validez fiscal: hay que reemitirla, y va primero.\n` +
          `4. biller_posicion_iva con periodo="${periodo}" — la estimación de IVA. ` +
          `Aclarale al usuario que es estimación de gestión, no declaración.\n` +
          `5. biller_cuenta_corriente — qué quedó sin cobrar del período.\n\n` +
          `Presentá el resultado en ese orden: primero lo que hay que ARREGLAR (rechazos), después ` +
          `lo que hay que PAGAR (IVA), después lo que hay que COBRAR, y al final los números del mes. ` +
          `Si algún dato tiene un caveat importante, decilo en la misma línea del número, no en una nota al pie.`,
      );
    },
  );

  server.registerPrompt(
    "revision_semanal",
    {
      title: "Revisión semanal",
      description:
        "Los cinco minutos del lunes: qué se rompió, qué hay que cobrar esta semana y cómo viene el mes.",
      argsSchema: {},
    },
    () =>
      mensaje(
        "Hacé la revisión semanal del negocio:\n\n" +
          "1. biller_alertas_operativas (periodo=ultimos_30_dias) — rechazos DGI y estado del CAE. " +
          "Un CAE por agotarse corta la facturación: si aparece, va primero que todo lo demás.\n" +
          "2. biller_vencimientos con horizonte de 7 días — qué se cobra esta semana y qué ya está vencido.\n" +
          "3. biller_resumen_facturacion_periodo (periodo=mes_actual) — cómo viene el mes contra lo esperable.\n\n" +
          "Devolvé como mucho cinco viñetas, cada una con una acción concreta. " +
          "Si no hay nada que atender, decilo en una línea: un informe que siempre trae tres párrafos " +
          "se deja de leer, y el día que sí importa tampoco se lee.",
      ),
  );

  server.registerPrompt(
    "salud_de_cartera",
    {
      title: "Salud de la cartera de clientes",
      description:
        "Concentración de ingresos, clientes nuevos, clientes que dejaron de comprar y quiénes deben.",
      argsSchema: {
        periodo: z
          .string()
          .optional()
          .describe("Período a analizar. Default: ultimos_90_dias."),
      },
    },
    ({ periodo }) =>
      mensaje(
        `Analizá la salud de la cartera de clientes (periodo="${periodo ?? "ultimos_90_dias"}"):\n\n` +
          `1. biller_ranking_clientes — top de facturación y el índice de concentración (HHI). ` +
          `Si el top 1 explica más del 30%, decilo explícitamente: es riesgo de dependencia, ` +
          `no un dato de color.\n` +
          `2. biller_ranking_clientes con solo_dormidos=true — quiénes dejaron de comprar. ` +
          `Esa es la lista de recuperación.\n` +
          `3. biller_ranking_clientes con solo_nuevos=true — de dónde viene el crecimiento.\n` +
          `4. biller_cuenta_corriente — cruzá: ¿alguno de los clientes grandes está además atrasado ` +
          `en los pagos? Ese cruce es el hallazgo más accionable de toda la revisión.\n\n` +
          `Cerrá con UNA recomendación concreta, no con un resumen de lo que ya dijiste.`,
      ),
  );

  server.registerPrompt(
    "que_puedo_preguntar",
    {
      title: "¿Qué le puedo preguntar a esto?",
      description: "Lista lo que se puede contestar con los datos de Biller y, sobre todo, lo que no.",
      argsSchema: {},
    },
    () =>
      mensaje(
        "Llamá a biller_catalogo_datos y explicame en castellano llano qué puedo preguntarle a este " +
          "sistema. Agrupá en tres: lo que contesta bien, lo que contesta con reservas (y cuáles son " +
          "esas reservas), y lo que directamente no puede contestar todavía con el motivo. " +
          "No me des la lista cruda de tools: dame las PREGUNTAS que puedo hacer.",
      ),
  );
}
