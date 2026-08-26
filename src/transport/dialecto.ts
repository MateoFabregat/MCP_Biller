// =============================================================================
// El dialecto de los schemas que salen por el wire.
//
// EL PROBLEMA, ENCONTRADO USANDO EL SERVER DE VERDAD
//
// Un cliente MCP estricto (Claude Code, ajv en modo 2020-12) rechazó TODAS las
// tools con `outputSchema`: no se podía ni llamar a `biller_health_check`. El
// motivo no está en nuestro código: el SDK, cuando los schemas son Zod v3,
// los convierte con `zod-to-json-schema`, que estampa
// `"$schema": "http://json-schema.org/draft-07/schema#"` — y la spec de MCP
// pide draft 2020-12. Un cliente laxo lo ignora; uno estricto corta ahí, y el
// usuario ve "invalid outputSchema" antes de la primera respuesta.
//
// EL ARREGLO, Y POR QUÉ ES QUITAR Y NO TRADUCIR
//
// Se borra la clave `$schema` de los schemas de tools que salen en
// `tools/list`. Sin la clave, el cliente asume el dialecto por defecto
// (2020-12), y para las formas que emite Zod —objetos, enums, arrays, todo
// inline— draft-07 y 2020-12 son el mismo documento. Traducir de verdad
// (definitions→$defs, etc.) sería código para casos que estos schemas no
// producen.
//
// MIGRAR A ZOD v4 NO ALCANZA (verificado contra el SDK 1.29.0)
//
// Es tentador pensar que el módulo se borra el día que los schemas pasen a Zod
// v4, porque el conversor nativo de v4 sabe emitir 2020-12. No: el SDK llama a
// `toJsonSchemaCompat(obj, { strictUnions, pipeStrategy })` sin pasar `target`
// (server/mcp.js, donde arma `inputSchema` y `outputSchema`), y adentro
// `mapMiniTarget(undefined)` devuelve `'draft-7'`. O sea que la rama v4 estampa
// el MISMO `$schema` de draft-07 que la v3:
//
//     z4mini.toJSONSchema(s, { target: 'draft-7' }).$schema
//       === "http://json-schema.org/draft-07/schema#"
//
// Lo que tendría que cambiar es upstream: que el SDK pase `target: 'draft-2020-12'`
// (o deje de estampar `$schema`). Hasta que eso pase —con Zod v3 o v4— este
// módulo sigue haciendo falta.
//
// VIVE EN EL TRANSPORTE porque es el único lugar que ven los tres runtimes
// (stdio, HTTP largo, serverless): envolver tool por tool sería tantos lugares
// como tools registradas, y parchear el SDK sería un lugar ajeno.
// =============================================================================

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const DIALECTO_VIEJO = "http://json-schema.org/draft-07/schema#";


export interface OpcionesDialecto {
  /**
   * Además del dialecto, quitar el `outputSchema` entero de cada tool.
   *
   * POR QUÉ EXISTE: el Agent Node de Kapso abría la sesión, pedía `tools/list`,
   * recibía 200… y configuraba el agente con CERO tools nuestras, sin error en
   * ningún lado. La lista pesaba 159 KB, y casi la mitad eran los
   * `outputSchema` — que para un agente conversacional no aportan nada: el
   * modelo lee `structuredContent` igual, con o sin schema declarado.
   *
   * `outputSchema` es OPCIONAL en la spec de MCP, así que quitarlo del wire es
   * legal y no cambia ninguna respuesta. Es opt-in (BILLER_WIRE_LIVIANO) porque
   * un cliente estricto como Claude Code sí lo aprovecha para validar.
   *
   * Y NO ERA EL TAMAÑO. Medido el 2026-08-26 contra el server real: sin los
   * `outputSchema`, `tools/list` bajó de 159 KB a 92 KB y Kapso seguía dando
   * CERO tools; sirviendo 3 tools y 4,8 KB desde un server de juguete, también
   * cero. La causa era un `$ref` — ver `inlinearRefs`.
   *
   * QUEDA ANOTADO PARA QUE NADIE LO REINVENTE: persiguiendo esa hipótesis se
   * llegó a recortar las descripciones de cada parámetro a 160 caracteres.
   * Bajaba de 92 KB a 82 KB, no arreglaba nada, y le sacaba al modelo el texto
   * con el que decide qué mandar en cada campo. Se borró. Si algún día un
   * cliente se ahoga de verdad con el tamaño, primero medir cuál es su límite.
   */
  quitarOutputSchema?: boolean;

}



/**
 * Inlinea los `$ref` internos de un schema. LA CAUSA DEL WHATSAPP MUDO.
 *
 * EL SÍNTOMA. El Agent Node de Kapso abría la sesión, pedía `tools/list`,
 * recibía 200 con las 34 tools… y configuraba el agente con CERO. Sin error en
 * ningún lado: ni en los eventos de Kapso, ni en nuestros logs, ni en el chat.
 * El usuario escribía "hola" y no le contestaba nadie.
 *
 * CÓMO SE ENCONTRÓ. Sirviendo la misma lista desde un server de juguete y
 * bisecando por cantidad de tools: con 2 cargaba, con 3 no. La tercera es
 * `biller_listar_comprobantes_emitidos`, y su `inputSchema` traía
 * `{"$ref": "#/properties/desde"}`. Once de las 34 tools tenían alguno.
 *
 * DE DÓNDE SALEN. `zod-to-json-schema` deduplica: cuando dos campos comparten
 * la MISMA instancia de schema —`const fecha = z.string()...` usada en `desde`
 * y en `hasta`— el segundo sale como un puntero al primero. Es JSON Schema
 * válido, y varios clientes lo rechazan igual.
 *
 * POR QUÉ DUELE TANTO. El rechazo es TODO-O-NADA: una sola tool con `$ref`
 * tira la lista entera. Por eso 33 tools impecables no servían de nada.
 *
 * POR QUÉ INLINEAR Y NO SACAR EL `$ref`. Borrarlo dejaría el campo sin tipo y
 * el modelo mandaría cualquier cosa. Inlinear produce un documento equivalente:
 * el mismo schema, escrito dos veces en vez de una. Cuesta bytes y no cuesta
 * precisión.
 *
 * VA SIEMPRE, no solo en modo liviano: un `$ref` que rompe un cliente lo rompe
 * con o sin `outputSchema`, y el resultado de inlinear es el mismo documento.
 */
function inlinearRefs(raiz: Record<string, unknown>): void {
  /**
   * Resuelve un puntero JSON ("#/properties/desde") contra la raíz del schema.
   * Devuelve undefined si no llega: un `$ref` roto se deja como está, que es
   * más honesto que inventarle un tipo.
   */
  function resolver(puntero: string): unknown {
    const partes = puntero.slice(2).split("/");
    let actual: unknown = raiz;
    for (const parte of partes) {
      if (typeof actual !== "object" || actual === null) return undefined;
      // Los punteros vienen escapados según RFC 6901.
      const clave = parte.replace(/~1/g, "/").replace(/~0/g, "~");
      actual = (actual as Record<string, unknown>)[clave];
    }
    return actual;
  }

  /**
   * `enCurso` corta los ciclos. Un schema recursivo —una categoría con
   * subcategorías— no se puede inlinear: expandirlo es infinito. En ese caso se
   * deja `{}`, que es permisivo pero finito. Ninguna tool de este proyecto
   * llega ahí hoy; está para que el día que llegue no se cuelgue el server.
   */
  function caminar(nodo: unknown, enCurso: ReadonlySet<string>): unknown {
    if (Array.isArray(nodo)) return nodo.map((h) => caminar(h, enCurso));
    if (typeof nodo !== "object" || nodo === null) return nodo;

    const obj = nodo as Record<string, unknown>;
    const ref = obj["$ref"];
    if (typeof ref === "string" && ref.startsWith("#/")) {
      if (enCurso.has(ref)) return {};
      const destino = resolver(ref);
      if (destino === undefined) return nodo;
      const expandido = caminar(destino, new Set([...enCurso, ref]));
      // Las claves hermanas del `$ref` ganan: en estos schemas la que aparece
      // es `description`, y es la del campo que apunta, no la del apuntado.
      const { $ref: _descartado, ...hermanas } = obj;
      return { ...(expandido as Record<string, unknown>), ...hermanas };
    }

    const salida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) salida[k] = caminar(v, enCurso);
    return salida;
  }

  // Se muta la raíz en su lugar porque el llamador ya tiene la referencia
  // metida adentro del mensaje que está por salir por el wire.
  const resuelto = caminar(raiz, new Set()) as Record<string, unknown>;
  for (const k of Object.keys(raiz)) delete raiz[k];
  Object.assign(raiz, resuelto);
}

/** Limpia los schemas de una lista de tools según las opciones. */
function limpiarListaDeTools(result: unknown, opciones: OpcionesDialecto): void {
  if (typeof result !== "object" || result === null) return;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const t = tool as Record<string, unknown>;
    if (opciones.quitarOutputSchema === true) delete t["outputSchema"];
    for (const clave of ["inputSchema", "outputSchema"] as const) {
      const schema = t[clave];
      if (typeof schema === "object" && schema !== null) {
        const s = schema as Record<string, unknown>;
        if (s["$schema"] === DIALECTO_VIEJO) delete s["$schema"];
        inlinearRefs(s);
      }
    }
  }
}

/**
 * Envuelve `transport.send` para limpiar todo `tools/list` que salga.
 * Devuelve el mismo transporte, para usarlo inline en el `connect`.
 */
export function conDialectoLimpio<T extends Transport>(
  transport: T,
  opciones: OpcionesDialecto = {},
): T {
  const enviarOriginal = transport.send.bind(transport);
  transport.send = (mensaje, opcionesEnvio) => {
    if (typeof mensaje === "object" && mensaje !== null && "result" in mensaje) {
      limpiarListaDeTools((mensaje as { result?: unknown }).result, opciones);
    }
    return enviarOriginal(mensaje, opcionesEnvio);
  };
  return transport;
}
