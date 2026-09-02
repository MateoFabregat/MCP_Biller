// =============================================================================
// El menú de WhatsApp: qué ve el dueño de la PyME cuando escribe "hola".
//
// POR QUÉ ESTO EXISTE COMO MÓDULO Y NO COMO PROMPT
//
// La alternativa era escribir el menú en el system prompt del agente de Kapso y
// que el modelo lo redacte cada vez. Tres razones para no hacerlo:
//
// 1. Un menú que cambia de redacción en cada conversación no es un menú. La
//    gente aprende "la 2 es la que me dice quién me debe"; si la 2 a veces es
//    otra cosa, deja de haber memoria muscular y vuelve a haber que leer todo.
// 2. Las opciones tienen que corresponder a tools que EXISTEN y están
//    habilitadas. En `read_only` no hay emisión: ofrecerla es mandar al usuario
//    contra una pared. Eso se sabe acá, no en el prompt.
// 3. Los ids de las opciones vuelven en la respuesta del usuario. Si los
//    inventa el modelo, no hay forma de enrutarlos.
//
// El modelo sigue haciendo lo que hace bien: entender "che, y los que me deben?"
// y llevarlo a la opción correcta. Lo que no hace es decidir qué opciones hay.
//
// -----------------------------------------------------------------------------
// ESTE ARCHIVO YA NO TIENE CÓDIGO: ES LA FACHADA DE CUATRO MÓDULOS.
//
// Eran cuatro responsabilidades en 1400 líneas, y se notaba en cómo se leían los
// diffs: agregar un sinónimo, cambiar el umbral de los typos, retocar el texto
// del preview y tocar el formato de un id caían todos en el mismo archivo, así
// que ninguno se podía revisar sin leer los otros tres. La partición:
//
//   · `intenciones.ts` — el CATÁLOGO. `OPCIONES_MENU` y los léxicos sueltos
//     (saludos, cortesías, afirmaciones, palabras vacías). Datos, no algoritmo.
//   · `enrutador.ts`   — `interpretarMensaje` y la maquinaria de matching:
//     normalización, exacto → número → sinónimo → inclusión → tokens → typos →
//     extractor de pedidos. El orden de los pasos es el invariante.
//   · `render.ts`      — los `construir*`: menú, listas, botones,
//     desambiguación, preview de emisión.
//   · `protocolo.ts`   — los prefijos de id (`menu:`, `emitir:`, `resolver:`) y
//     los lectores que los interpretan de vuelta.
//
// La dependencia va en una sola dirección: `protocolo` no depende de nadie,
// `intenciones` depende del protocolo, y `enrutador` y `render` dependen de los
// dos primeros sin conocerse entre sí.
//
// LA FACHADA EXISTE PARA QUE NADIE TENGA QUE CAMBIAR SU IMPORT. Re-exporta todo
// lo que este archivo exportaba, así los importadores de siempre —la tool, el
// webhook, los tests, los evals— siguen andando igual. Pero código nuevo debería
// importar del módulo específico: es lo que hace que se vea, en el import, cuál
// de las cuatro capas está tocando.
// =============================================================================

export {
  PREFIJO_EMISION,
  PREFIJO_ANULACION,
  PREFIJO_MENU,
  PREFIJO_RESOLVER,
  interpretarRespuestaEmision,
  interpretarRespuestaAnulacion,
  interpretarRespuestaResolucion,
  type RespuestaEmision,
  type RespuestaAnulacion,
} from "./protocolo.js";

export {
  OPCIONES_MENU,
  intencionesDisponibles,
  opcionesDisponibles,
  type MenuOpcion,
  type MenuOpciones,
} from "./intenciones.js";

export {
  interpretarMensaje,
  normalizarTexto,
  type Interpretacion,
} from "./enrutador.js";

export {
  construirConfirmacionEmision,
  construirConfirmacionAnulacion,
  construirRevisionAnulacion,
  construirDesambiguacion,
  construirMenuInteractivo,
  construirMenuTexto,
} from "./render.js";
