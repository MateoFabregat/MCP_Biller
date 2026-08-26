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
// =============================================================================

import type { BillerCapabilityMode } from "../config.js";
import { similitudEdicion } from "../services/resolver.js";
import type { InteractivoBotones, InteractivoLista } from "./client.js";
import { PREFIJO_PASO } from "./emision.js";
import { esPedidoDeEmision, extraerPedidoEmision } from "./extraerPedido.js";

/** Prefijo de los ids del menú. Distingue una elección de menú de otras respuestas. */
export const PREFIJO_MENU = "menu:";

/** Prefijo de los ids de la confirmación de emisión. */
export const PREFIJO_EMISION = "emitir:";

/**
 * Prefijo de los botones de desambiguación de `biller_resolver_nombre`.
 *
 * Cuarto prefijo propio, y va con los otros tres por el mismo motivo: llega como
 * texto igual que "hola". Sin esta rama, "resolver:cliente:0" —la respuesta a
 * "¿cuál de estos dos clientes?"— no matchea ningún sinónimo, cae en
 * `desconocido` y el bot contesta el menú entero: el usuario acaba de elegir
 * entre dos candidatos y lo mandan al principio.
 */
export const PREFIJO_RESOLVER = "resolver:";

export interface MenuOpcion {
  /** Id estable. Vuelve tal cual cuando el usuario toca la fila. */
  id: string;
  /** Lo que se ve en la fila. Máx. 24 caracteres (límite de WhatsApp). */
  titulo: string;
  /** Segunda línea de la fila. Máx. 72. */
  descripcion: string;
  /** Sección de la lista donde va. */
  grupo: "Plata" | "Facturar" | "Números" | "Otros";
  /** Qué tool contesta esta opción. Es lo que el agente tiene que llamar. */
  tools: string[];
  /** true si solo tiene sentido con las tools de escritura habilitadas. */
  requiereEscritura?: boolean;
  /**
   * true = el enrutador la reconoce pero NO ocupa una fila de la lista.
   *
   * WhatsApp permite 10 filas sumando secciones, y el menú ya usa las 10. Sin
   * esta distinción, "lo que se puede pedir" quedaba atado a "lo que entra en
   * la pantalla": había tools registradas y andando —el ranking de productos,
   * las compras a proveedores, registrar un cobro— a las que NINGUNA frase del
   * usuario podía llegar, porque el enrutador solo sabía enrutar a filas.
   *
   * El menú es la vidriera; esto es el catálogo. Una intención oculta se
   * descubre preguntando ("¿qué productos vendo más?") y `biller_catalogo_datos`
   * la nombra cuando el usuario pregunta qué se puede hacer.
   */
  oculta?: boolean;
  /** Frases del usuario que llevan acá sin pasar por el menú. */
  sinonimos: string[];
}

/**
 * El catálogo. El orden es el orden en que se muestran.
 *
 * FACTURAR VA PRIMERO, y "Emitir un comprobante" es la opción 1. El orden
 * anterior ponía la plata adelante por frecuencia de consulta, pero eso mide la
 * pregunta equivocada: emitir es la única opción que el dueño de la PyME NO
 * puede resolver mirando otra pantalla, y es la que tiene al cliente esperando
 * del otro lado del mostrador. Cobrar puede esperar treinta segundos; facturar
 * no.
 *
 * EL CRITERIO, EXTENDIDO A LAS DIEZ FILAS: LO DEL MOSTRADOR ARRIBA.
 *
 * El mismo argumento que puso a emitir en la 1 decide el resto del orden, y no
 * la frecuencia con que se consulta cada cosa. Lo que cambió:
 *
 *   · "Lo de siempre" (menu:repetir) SUBE A LA 2. Es el camino de dos mensajes
 *     —"lo de siempre a Pérez" y confirmar— y estaba OCULTO, o sea invisible
 *     para todo el que no supiera que existía. La función más rápida del
 *     producto no puede ser la que hay que adivinar.
 *   · "Registrar un cobro" (menu:cobro) SUBE A LA 5, pegado a "¿Quién me
 *     debe?". Estaban separados por la visibilidad: se veía el saldo y no había
 *     cómo decir "esta ya me la pagaron". Ver la deuda sin poder tocarla es lo
 *     que hace que la gente vuelva a la planilla.
 *   · "Ver un comprobante" ENTRA COMO 3. Buscar lo que ya se emitió es la
 *     segunda cosa que se hace en un mostrador (después de emitir) y no tenía
 *     ninguna fila: se llegaba de casualidad por "mandame el pdf".
 *   · "Plata en riesgo", "Mis clientes" y "Cosas para atender" BAJAN A OCULTAS.
 *     Son analítica: se leen sentado, una vez por semana, no con un cliente
 *     enfrente. El enrutador las sigue entendiendo igual — bajar de fila no es
 *     sacar del catálogo (ver `oculta`).
 *   · "Mandar" y "Anular" bajan a las filas 8 y 9 y cambian de sección a
 *     "Otros". El grupo es el ENCABEZADO de sección que ve el usuario, y las
 *     secciones tienen que quedar contiguas o el número que se escribe deja de
 *     coincidir con la fila que se toca (ver `construirMenuInteractivo`). Las
 *     dos son cosas que se le hacen a un comprobante que YA existe, así que
 *     bajarlas del grupo "Facturar" describe mejor lo que son.
 */
export const OPCIONES_MENU: readonly MenuOpcion[] = [
  {
    id: `${PREFIJO_MENU}emitir`,
    titulo: "Emitir un comprobante",
    descripcion: "Te guío paso a paso y confirmás antes de emitir",
    grupo: "Facturar",
    tools: ["biller_emision_guiada", "biller_requisitos_comprobante", "biller_emitir_comprobante"],
    requiereEscritura: true,
    sinonimos: [
      "emitir", "facturar", "hacer una factura", "hacele una factura", "nueva factura",
      "e-ticket", "eticket", "quiero facturar", "emitir comprobante", "emitir factura",
      "hacer un comprobante", "facturarle a", "cobrarle a", "boleta", "necesito facturar",
      "tengo que facturar", "hacer una boleta", "emitir un comprobante",
      "hacerle la factura", "hacerle una factura", "necesito una factura", "facturame",
      "hacer factura", "armar una factura", "le tengo que facturar", "cobrale a",
      // Imperativo con clítico: es COMO ESCRIBE LA GENTE, y faltaba entero.
      // "facturale a perez 2 bolsas a 6500" —el ejemplo que `emision.ts`
      // documenta como el punto de entrada real del flujo— caía en "no entendí"
      // porque el catálogo tenía "facturarle a" (infinitivo) y nadie escribe así.
      "facturale", "facturales", "hacele", "emitile", "emitila", "emitilo",
      "mandale una factura", "tirale una factura", "sacale una factura",
    ],
  },
  {
    // "Lo de siempre" es SU propia intención y no un sinónimo de "emitir":
    // enrutan a la misma tool, pero el agente tiene que llamarla DISTINTO
    // (con `repetir_ultima_de`), y esa diferencia solo se puede transmitir si
    // la opción es otra. Un sinónimo más de "emitir" habría hecho el match y
    // perdido el dato de que hay que copiar la factura anterior.
    //
    // YA NO ESTÁ OCULTA. Era el camino más corto del producto —dos mensajes
    // hasta un CFE— y solo llegaba el que ya sabía la fórmula. Una función que
    // hay que adivinar no existe para el 90% de la gente.
    id: `${PREFIJO_MENU}repetir`,
    titulo: "Lo de siempre",
    descripcion: "Repite la última factura de un cliente: mismos ítems, mismos precios",
    grupo: "Facturar",
    tools: ["biller_resolver_nombre", "biller_emision_guiada"],
    requiereEscritura: true,
    sinonimos: [
      "lo de siempre", "facturale lo de siempre", "lo mismo de siempre", "otra igual",
      "la misma factura", "repetir factura", "facturale lo mismo", "lo mismo que ayer",
      "lo mismo del otro dia", "otra como la anterior", "repetile la factura",
      "hacele la de siempre", "la de todas las semanas",
    ],
  },
  {
    // BUSCAR UN COMPROBANTE YA EMITIDO NO TENÍA NINGUNA PUERTA.
    //
    // Las tres tools existen y andan desde siempre, pero la única entrada desde
    // el chat era "mandame el pdf" — o sea, para MIRAR una factura había que
    // pedir que te la manden. "¿cuánto le facturé a Pérez la última vez?" caía
    // en "no entendí" con el dato a un GET de distancia.
    id: `${PREFIJO_MENU}ver_comprobantes`,
    titulo: "Ver un comprobante",
    descripcion: "Busca una factura ya emitida y te muestra el detalle",
    grupo: "Facturar",
    tools: [
      "biller_listar_comprobantes_emitidos",
      "biller_obtener_comprobante",
      "biller_obtener_pdf",
    ],
    sinonimos: [
      "ver un comprobante", "ver una factura", "ver la factura", "ver comprobantes",
      "mostrame las ultimas facturas", "mostrame la ultima factura", "mostrame la factura",
      "mostrame las facturas", "ultimas facturas", "ultimos comprobantes",
      // "la ultima factura de" lleva la preposición pegada A PROPÓSITO: sin
      // ella, "la ultima factura" es subcadena de "mandame el pdf de la ultima
      // factura" y le robaba el mensaje a "Mandar un comprobante" por ser el
      // sinónimo más largo. Con la preposición, solo matchea cuando después
      // viene un cliente ("la última factura de Pérez"), que es este caso.
      "la ultima factura de", "cual fue la ultima factura", "detalle de la factura",
      "buscar una factura", "buscame la factura", "que le facture a",
      "la factura numero", "el comprobante numero", "que facturas emiti",
    ],
  },
  {
    id: `${PREFIJO_MENU}cobranzas`,
    titulo: "¿Quién me debe?",
    descripcion: "Saldo por cliente y facturas vencidas",
    grupo: "Plata",
    tools: ["biller_cuenta_corriente", "biller_vencimientos"],
    sinonimos: [
      "quien me debe", "deudores", "cobranzas", "deuda", "me deben", "cobrar",
      "quien me debe plata", "cuanto me deben", "facturas impagas", "morosos",
      "saldo de clientes", "cuentas por cobrar", "clientes en deuda", "cuanto me debe",
      "cuenta corriente", "saldo de cuenta corriente", "saldo del cliente", "facturas vencidas",
      "que me deben", "sin pagar",
    ],
  },
  {
    // VA PEGADO A "¿QUIÉN ME DEBE?" Y NO ESTÁ MÁS OCULTO.
    //
    // Eran las dos mitades de la misma tarea separadas por la visibilidad: el
    // usuario veía la deuda y no tenía cómo decir "esta ya me la pagaron". Ver
    // el saldo sin poder tocarlo es lo que hace que la gente vuelva a la
    // planilla.
    id: `${PREFIJO_MENU}cobro`,
    titulo: "Registrar un cobro",
    descripcion: "Marca una factura como cobrada (emite el recibo)",
    grupo: "Plata",
    tools: ["biller_cuenta_corriente", "biller_crear_recibo"],
    requiereEscritura: true,
    sinonimos: [
      "me pagaron", "registrar un cobro", "registrar un pago", "cobre una factura",
      "me deposito", "recibi un pago", "marcar como pagada", "ya me pago",
      "me pago el cliente", "hacer un recibo", "emitir un recibo",
    ],
  },
  {
    id: `${PREFIJO_MENU}dia`,
    titulo: "Resumen del día",
    descripcion: "Lo urgente, las cobranzas y lo facturado, en un mensaje",
    grupo: "Plata",
    tools: ["biller_reporte_diario"],
    sinonimos: [
      "resumen del dia", "reporte", "digest", "como viene el dia", "novedades",
      "que paso hoy", "resumen diario", "como venimos hoy",
      // LO DE HOY ES DEL DÍA, NO DEL MES.
      //
      // "ventas de hoy" y "qué vendí hoy" caían en "no entendí": el catálogo
      // tenía "ventas del mes" y "cuánto vendí", y la palabra que las
      // distingue —"hoy"— no aparecía en ninguna intención. La coincidencia
      // exacta gana antes que cualquier puntaje por tokens, así que estas
      // frases van completas y no le sacan nada a `menu:mes`.
      "ventas de hoy", "ventas del dia", "que vendi hoy", "cuanto vendi hoy",
      "cuanto facture hoy", "lo de hoy", "cuanto llevo hoy", "como viene hoy",
    ],
  },
  {
    id: `${PREFIJO_MENU}mes`,
    titulo: "¿Cómo viene el mes?",
    descripcion: "Facturado del período y comparación con el anterior",
    grupo: "Números",
    tools: ["biller_resumen_facturacion_periodo", "biller_comparar_periodos"],
    sinonimos: [
      "como viene el mes", "cuanto facture", "facturacion", "ventas del mes",
      "como dio el mes", "como dieron el mes", "cuanto vendi", "cierre del mes",
      "facturacion del mes", "como fue el mes", "cuanto facture este mes",
      "cuanto llevo facturado", "mes pasado", "comparar con el mes pasado",
      "vendimos mas", "vendi mas", "cuanto vendimos", "como venimos con las ventas",
      // "comparame junio con julio": los meses no están en ningún catálogo y no
      // van a estarlo, así que la evidencia es el VERBO. Va como palabra suelta
      // (matchea por token, no por subcadena) y `menu:sucursales` se defiende
      // con frases más largas —"comparame los locales"— que le ganan por
      // longitud sin llegar a un empate, porque la contienen.
      "comparame", "comparar", "compara", "comparar periodos", "comparar los meses",
      "comparame los meses", "compara los meses",
    ],
  },
  {
    id: `${PREFIJO_MENU}enviar_pdf`,
    titulo: "Mandar un comprobante",
    descripcion: "Adjunta el PDF de un CFE ya emitido",
    grupo: "Otros",
    tools: ["biller_listar_comprobantes_emitidos", "biller_enviar_comprobante_whatsapp"],
    sinonimos: [
      "mandar factura", "enviar pdf", "pdf", "adjuntar factura", "mandame la factura",
      "mandar comprobante", "enviar comprobante", "reenviar factura", "pasame la factura",
      "necesito el pdf", "mandale la factura", "me pide el comprobante", "pide la factura",
      "mandarle el comprobante", "reenviar el comprobante",
      // Cómo transcribe WhatsApp un audio que dice "pedeefe". No es un typo:
      // es el canal. Va como palabra suelta porque nadie la escribe por error.
      "pedeefe", "mandame el pedeefe", "pasame el pedeefe",
      // Más largo que "la ultima factura de" a propósito: ver el comentario de
      // `menu:ver_comprobantes`. Acá gana el que trae el PDF.
      "pdf de la ultima factura", "el pdf de la ultima", "pedeefe de la ultima",
    ],
  },
  {
    id: `${PREFIJO_MENU}anular`,
    titulo: "Anular un comprobante",
    descripcion: "Te dice exactamente qué nota de crédito hace falta",
    grupo: "Otros",
    // EL PLAN PRIMERO, PERO LA TOOL QUE ANULA TAMBIÉN DECLARADA.
    //
    // `biller_plan_anulacion` sigue siendo el camino —distingue anular una
    // venta (NC) de revertir una anulación (ND) y avisa si ya hay una nota de
    // crédito encima—, pero el agente necesita las DOS: con una sola, sabía qué
    // había que emitir y no tenía con qué emitirlo, y terminaba buscando la
    // tool por su cuenta o contestando "andá a Biller".
    //
    // No lleva `requiereEscritura`: en modo consulta el plan se calcula igual y
    // es la mitad útil de la respuesta. Marcarla cerraría una intención que en
    // read_only sigue teniendo algo que contestar.
    tools: ["biller_plan_anulacion", "biller_anular_comprobante"],
    sinonimos: [
      "anular", "cancelar factura", "nota de credito", "me equivoque", "anular comprobante",
      "dar de baja una factura", "esta mal la factura", "anular factura",
      "como anulo", "hay que anular", "anular la factura", "tengo que anular",
      // Imperativo con clítico. "anulala" a secas es una frase completa acá.
      "anulala", "anulalo", "anulame", "dala de baja", "bajala",
      // El imperativo SIN acento y sin clítico ("anula la última"), que es como
      // llega la mitad de los mensajes escritos desde el teléfono. Van como
      // palabras sueltas: ninguna de las dos aparece por accidente en otra
      // intención, y "anular la 456" ya se apoyaba en la misma regla.
      "anula", "borra", "borrala", "borralo", "borrar la factura", "borra la ultima",
    ],
  },
  {
    id: `${PREFIJO_MENU}ayuda`,
    titulo: "¿Qué más podés hacer?",
    descripcion: "Lo que sé contestar y lo que no",
    grupo: "Otros",
    tools: ["biller_catalogo_datos"],
    sinonimos: [
      "ayuda", "help", "que podes hacer", "opciones", "que sabes hacer",
      "que mas podes hacer", "para que servis", "que puedo preguntar",
      "que otras cosas podes hacer", "en que me podes ayudar",
    ],
  },

  // --- De acá para abajo: intenciones OCULTAS ------------------------------
  //
  // No ocupan fila (la lista ya usa las 10 que permite WhatsApp) pero el
  // enrutador las reconoce. Cada una corresponde a una tool REGISTRADA que
  // antes no tenía ninguna puerta de entrada desde el chat: preguntar por ellas
  // caía en "no entendí" aunque el server supiera contestar perfectamente.
  //
  // Las TRES PRIMERAS bajaron de la vidriera en el reorden de mostrador, y esa
  // es la diferencia entre este archivo y una lista de features: bajar de fila
  // no saca nada del catálogo. "Plata en riesgo" se sigue entendiendo palabra
  // por palabra; lo único que cambió es que no le ocupa el lugar a "Registrar
  // un cobro" en la pantalla de alguien que tiene un cliente enfrente.
  {
    id: `${PREFIJO_MENU}riesgo`,
    titulo: "Plata en riesgo",
    descripcion: "Clientes que se están yendo y deuda por vencer",
    grupo: "Plata",
    tools: ["biller_plata_en_riesgo"],
    oculta: true,
    sinonimos: [
      "riesgo", "plata en riesgo", "alertas de plata", "clientes en fuga",
      "que plata puedo perder", "clientes que se van", "clientes que se estan yendo",
      "se me van los clientes", "que puedo perder",
    ],
  },
  {
    id: `${PREFIJO_MENU}clientes`,
    titulo: "Mis clientes",
    descripcion: "Top, nuevos, dormidos y cuánto dependés de uno solo",
    grupo: "Números",
    tools: ["biller_ranking_clientes"],
    oculta: true,
    sinonimos: [
      "clientes", "mejores clientes", "ranking", "top clientes", "mis clientes",
      "quien me compra mas", "clientes nuevos", "clientes dormidos",
    ],
  },
  {
    id: `${PREFIJO_MENU}alertas`,
    titulo: "Cosas para atender",
    descripcion: "Rechazos de DGI, CAE por agotarse y otros pendientes",
    grupo: "Otros",
    tools: ["biller_alertas_operativas"],
    oculta: true,
    sinonimos: [
      "alertas", "problemas", "rechazos", "dgi", "pendientes", "cosas para atender",
      "hay algo mal", "que tengo pendiente", "hay algun problema", "hay algo rechazado",
      "el cae", "se me acaba el cae", "certificado de dgi", "problemas con dgi",
    ],
  },
  {
    // Lo que ME facturaron. `biller_listar_comprobantes_recibidos` está
    // registrada desde siempre y no había ninguna frase que llegara: "¿qué
    // facturas me llegaron?" caía en "no entendí" o —peor— en las facturas
    // EMITIDAS, que es contestar con la plata que entra una pregunta sobre la
    // plata que sale.
    id: `${PREFIJO_MENU}recibidos`,
    titulo: "Lo que me facturaron",
    descripcion: "Comprobantes que te emitieron tus proveedores",
    grupo: "Números",
    tools: ["biller_listar_comprobantes_recibidos"],
    oculta: true,
    sinonimos: [
      "que facturas me llegaron", "facturas recibidas", "comprobantes recibidos",
      "que me facturaron", "que factura me llego", "me llego una factura",
      "facturas que recibi", "lo que me facturaron", "comprobantes que me emitieron",
    ],
  },
  {
    // "Me equivoqué con el recibo" NO es "me equivoqué con la factura".
    //
    // Un recibo mal hecho se CANCELA (biller_cancelar_recibo); una factura mal
    // hecha se anula con una nota de crédito. Sin esta intención, la frase
    // matcheaba "me equivoque" y caía en `menu:anular`, así que el agente
    // arrancaba a armar una NC por un recibo — un documento fiscal de más por
    // un problema que se resolvía con otra tool.
    id: `${PREFIJO_MENU}cancelar_recibo`,
    titulo: "Deshacer un cobro",
    descripcion: "Cancela un recibo mal emitido y devuelve el saldo",
    grupo: "Plata",
    tools: ["biller_cuenta_corriente", "biller_cancelar_recibo"],
    requiereEscritura: true,
    oculta: true,
    sinonimos: [
      // Todas LARGAS a propósito: la inclusión ordena por longitud, así que
      // "me equivoque con el recibo" (26) le gana a "me equivoque" (12) de
      // `menu:anular`, y como una contiene a la otra no hay empate que
      // preguntar. Un sinónimo corto acá volvería a chocar con anular.
      "me equivoque con el recibo", "me equivoque en el recibo", "el recibo esta mal",
      "cancelar el recibo", "anular el recibo", "borrar el recibo",
      "deshacer un cobro", "el cobro estaba mal", "cancelar un recibo",
      "el recibo esta mal hecho", "me equivoque al cobrar",
    ],
  },
  {
    id: `${PREFIJO_MENU}recordar_cobro`,
    titulo: "Reclamar una deuda",
    descripcion: "Le manda al cliente su saldo, con tu OK antes de salir",
    grupo: "Plata",
    tools: ["biller_cuenta_corriente", "biller_recordatorio_cobro"],
    oculta: true,
    sinonimos: [
      "reclamar una deuda", "mandarle el saldo", "recordatorio de pago", "intimar",
      "avisarle que me debe", "mandarle un recordatorio", "reclamarle la plata",
      "que me pague", "pedirle que pague", "recordarle el pago",
    ],
  },
  {
    id: `${PREFIJO_MENU}productos`,
    titulo: "Qué vendo más",
    descripcion: "Ranking de productos, con dispersión de precios",
    grupo: "Números",
    tools: ["biller_ranking_productos"],
    oculta: true,
    sinonimos: [
      "que productos vendo mas", "productos mas vendidos", "ranking de productos",
      "que vendo mas", "mis productos", "que es lo que mas vendo",
    ],
  },
  {
    id: `${PREFIJO_MENU}iva`,
    titulo: "IVA del mes",
    descripcion: "Qué se puede y qué no decir sobre el IVA",
    grupo: "Números",
    // Apunta al CATÁLOGO, no a `biller_posicion_iva`, y a propósito: esa tool
    // es opt-in y no está registrada salvo que se habilite. El catálogo, que sí
    // está siempre, explica exactamente por qué y qué contestarle al usuario.
    //
    // Sin esta intención, "¿cuánto tengo que pagar de IVA?" caía en el matching
    // por palabras y se contestaba con LO FACTURADO DEL MES: un número de plata
    // con cara de respuesta, a una pregunta de plata distinta. Un "esto no lo sé
    // calcular" es infinitamente mejor que un número que no es el que se pidió.
    tools: ["biller_catalogo_datos"],
    oculta: true,
    sinonimos: [
      "cuanto tengo que pagar de iva", "iva del mes", "cuanto me da iva",
      "posicion de iva", "iva a pagar", "cuanto de iva", "el iva",
      "cuanto pago de iva", "iva ventas", "credito fiscal", "iva compras",
    ],
  },
  {
    id: `${PREFIJO_MENU}sucursales`,
    titulo: "Cómo va cada local",
    descripcion: "Participación de cada sucursal y si subió o bajó",
    grupo: "Números",
    tools: ["biller_ranking_sucursales"],
    oculta: true,
    sinonimos: [
      "como va cada local", "por sucursal", "ranking de sucursales", "mis locales",
      "cuanto vendio cada local", "comparar sucursales", "que local vende mas",
      "facturacion por sucursal", "como van los locales",
      // La defensa contra el "comparame" suelto de `menu:mes`: estas frases lo
      // CONTIENEN, así que ganan por longitud sin producir un empate.
      "comparame los locales", "comparame las sucursales", "comparar los locales",
      "comparame cada local",
    ],
  },
  {
    // Salud del sistema, no del negocio.
    //
    // Está oculta y con sinónimos que nadie escribe por accidente ("como viene
    // funcionando el bot"), porque el destinatario no es el almacenero: es
    // quien opera el server. Pero tiene que ser ALCANZABLE igual — la regla del
    // HANDBOOK §6 es que una tool registrada a la que ninguna frase puede
    // llegar es una tool que no existe, y esta se había registrado sin entrada.
    id: `${PREFIJO_MENU}metricas`,
    titulo: "¿Cómo viene funcionando esto?",
    descripcion: "Cuánto se entiende, dónde se abandonan las emisiones",
    grupo: "Números",
    tools: ["biller_metricas"],
    oculta: true,
    sinonimos: [
      "como viene funcionando el bot", "metricas del sistema", "cuanto entendes",
      "estadisticas de uso", "salud del sistema", "cuantos mensajes no entendiste",
    ],
  },
  {
    id: `${PREFIJO_MENU}cohortes`,
    titulo: "¿Los clientes vuelven?",
    descripcion: "Retención por mes de alta: quién sigue comprando",
    grupo: "Números",
    tools: ["biller_cohortes_clientes"],
    oculta: true,
    sinonimos: [
      "los clientes vuelven", "retencion de clientes", "cohortes", "vuelven a comprar",
      "cuantos clientes repiten", "clientes que repiten", "se quedan los clientes",
      "que pasa con los clientes nuevos",
    ],
  },
  {
    id: `${PREFIJO_MENU}proveedores`,
    titulo: "Mis compras",
    descripcion: "Qué le compré a cada proveedor (devengado)",
    grupo: "Números",
    tools: ["biller_compras_proveedores"],
    oculta: true,
    sinonimos: [
      "cuanto compre", "mis proveedores", "compras del mes", "cuanto le compre",
      "gastos con proveedores", "compras a proveedores", "que compre",
    ],
  },
  {
    id: `${PREFIJO_MENU}alta_cliente`,
    titulo: "Dar de alta un cliente",
    descripcion: "Carga un cliente nuevo en Biller",
    grupo: "Otros",
    tools: ["biller_crear_cliente"],
    requiereEscritura: true,
    oculta: true,
    sinonimos: [
      "dar de alta un cliente", "cargar un cliente", "cliente nuevo", "agregar un cliente",
      "crear un cliente", "alta de cliente",
    ],
  },
  {
    id: `${PREFIJO_MENU}alta_producto`,
    titulo: "Cargar un producto",
    descripcion: "Da de alta un producto o servicio en Biller",
    grupo: "Otros",
    tools: ["biller_cargar_producto"],
    requiereEscritura: true,
    oculta: true,
    sinonimos: [
      "cargar un producto", "dar de alta un producto", "agregar un producto",
      "producto nuevo", "cargar un articulo", "crear un producto",
    ],
  },
  {
    id: `${PREFIJO_MENU}pago_proveedor`,
    titulo: "Registrar un pago",
    descripcion: "Deja asentado lo que le pagaste a un proveedor",
    grupo: "Otros",
    tools: ["biller_crear_pago"],
    requiereEscritura: true,
    oculta: true,
    sinonimos: [
      "le pague a un proveedor", "registrar un pago a proveedor", "pague una factura de compra",
      "pagar a proveedor", "asentar un pago",
    ],
  },
  {
    id: `${PREFIJO_MENU}datos_rut`,
    titulo: "Datos de un RUT",
    descripcion: "Razón social y situación en DGI de un RUT",
    grupo: "Otros",
    tools: ["biller_buscar_cliente_por_rut"],
    oculta: true,
    sinonimos: [
      "datos de un rut", "de quien es este rut", "razon social del rut", "buscar por rut",
      "consultar un rut", "a nombre de quien esta este rut",
    ],
  },
] as const;

/** Saludos y aperturas que disparan el menú sin más contexto. */
const SALUDOS = [
  "hola", "holaa", "ola", "buenas", "buen dia", "buenos dias", "buenas tardes",
  "buenas noches", "hey", "hi", "hello", "que tal", "menu", "empezar", "start",
  "inicio", "volver", "arrancar", "buenass", "holis", "menu principal", "atras",
];

/**
 * Cortesías: "gracias", "dale", "listo".
 *
 * Tienen entrada propia porque la alternativa es tratarlas como "no entendí" y
 * contestar un "gracias" con el menú entero. Eso es exactamente el momento en
 * que una conversación deja de sentirse como una conversación. No abren ni
 * cierran nada: se acusan recibo y se queda esperando.
 */
/**
 * "Sí, dale, emitila". Confirmaciones que llegan escritas en vez de tocadas.
 *
 * `no` estaba en CORTESIAS desde el principio; `si` no estaba en ningún lado, y
 * el usuario que confirmaba el preview escribiendo recibía el MENÚ ENTERO. La
 * asimetría es la peor posible: se podía cancelar por texto pero no aceptar.
 *
 * No abren ni cierran nada por sí mismas — le dicen al agente que aplique la
 * respuesta al paso que estaba pendiente.
 */
const AFIRMACIONES = [
  "si", "si dale", "dale si", "confirmo", "correcto", "exacto", "asi es",
  "emitila", "emitilo", "emiti", "mandala", "mandalo", "asi esta bien", "esta bien",
  "ok emitila", "dale emitila", "si por favor", "afirmativo", "sip", "sisi", "obvio",
  "adelante", "procede", "hacelo",
];

/**
 * "Pará, no lo emitas". Cancelaciones escritas.
 *
 * Peor que la falta de "sí": el usuario cree que canceló y el sistema le
 * contesta el menú. Si el paso pendiente era la confirmación de una emisión, la
 * diferencia entre entender esto y no entenderlo es un CFE ante DGI.
 */
const CANCELACIONES = [
  "para", "para para", "frena", "frena ahi", "cancelar", "cancela", "cancelalo",
  "no lo emitas", "no emitas", "no la emitas", "para no lo emitas", "para no emitas", "no cancelalo", "dejalo",
  "espera no lo mandes", "esperate", "olvidate", "dejalo asi", "mejor no", "no sigas",
  "abortar", "abortalo",
];

/**
 * Asentimientos DÉBILES: "dale", "listo", "ok", "joya".
 *
 * Son la palabra más común de la conversación uruguaya, y son genuinamente
 * ambiguas: después de "¿lo emito?" son un sí; después de un reporte son un
 * "gracias". Un enrutador sin estado no puede saber cuál de las dos — pero SÍ
 * puede saber quién lo sabe: el agente, que tiene la conversación.
 *
 * Antes estaban en CORTESIAS, y cortesía se AUTORESPONDE en el webhook con un
 * texto enlatado. O sea: "¿Lo emito?" → "dale" → "Dale, cualquier cosa
 * escribime". La confirmación quedaba huérfana sin ninguna salida — fallaba
 * seguro (no emitía), pero el flujo moría justo en el último paso.
 *
 * Ahora enrutan como `afirmacion`, que se DELEGA en vez de autoresponderse. La
 * instrucción del agente ya contempla el caso débil: si no había ninguna
 * pregunta abierta, acusa recibo y listo.
 */
const ASENTIMIENTOS = [
  "dale", "listo", "ok", "oka", "okey", "perfecto", "barbaro", "genial",
  "buenisimo", "de una", "joya", "ta",
];

/**
 * El "no" pelado enruta como cancelación, no como cortesía.
 *
 * Mismo razonamiento que ASENTIMIENTOS pero con la asimetría al revés: un "no"
 * después de "¿lo emito?" leído como cortesía deja la confirmación colgada; un
 * "no gracias" después de "¿algo más?" leído como cancelación cuesta, a lo
 * sumo, una frase rara ("quedó sin hacer" cuando no había nada). El error
 * barato es siempre el que NO ejecuta y NO deja nada colgado.
 *
 * "no gracias" / "nada más" / "eso es todo" quedan en cortesía: esas fórmulas
 * solo se usan para cerrar, nunca para frenar una emisión.
 */
const NEGACIONES_SECAS = ["no", "nop", "no no"];

const CORTESIAS = [
  "gracias", "muchas gracias", "chau", "saludos",
  "nada mas", "nada", "eso es todo", "ninguna", "no gracias",
];

/**
 * Palabras que no distinguen nada. Se sacan antes de comparar por tokens: son
 * las que hacen que "¿cómo viene el mes?" y "¿cómo dieron el mes?" parezcan
 * distintas cuando son la misma pregunta.
 */
const VACIAS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a",
  "en", "y", "o", "que", "qué", "me", "mi", "mis", "te", "se", "lo", "le", "les",
  "es", "por", "para", "con", "sin", "mas", "muy", "ya", "hay", "esta", "este",
  "esto", "eso", "esa", "ese", "su", "sus", "yo", "vos", "tu", "che", "porfa",
  "por favor", "decime", "quiero", "necesito", "podes", "puedo", "dame", "pasame",
  // Las que rodean a un número cuando el usuario elige una fila escribiendo:
  // "opción 3", "el número 5", "2 por favor". Sin ellas, `tokenizar` deja dos
  // tokens y la elección se pierde: el usuario que ya eligió recibe el menú.
  // ("por favor" nunca matchea como token suelto — por eso hace falta "favor".)
  "favor", "opcion", "opciones", "numero", "nro", "la", "punto",
]);

/** Tokens con contenido de un texto ya normalizado. */
function tokenizar(norm: string): string[] {
  return norm.split(" ").filter((t) => t !== "" && !VACIAS.has(t));
}

/**
 * Cuánto se parecen dos frases contando palabras con contenido.
 *
 * Devuelve la fracción de los tokens del SINÓNIMO que aparecen en el mensaje.
 * Se mide contra el sinónimo y no contra el mensaje a propósito: el usuario
 * agrega palabras ("¿me decís cómo viene el mes que viene?") y eso no debería
 * bajar el puntaje, pero omitir palabras del sinónimo sí.
 *
 * TOLERA TYPOS, y esa fue la corrección más grande del enrutador. La versión
 * anterior comparaba tokens por igualdad exacta, con el argumento —correcto en
 * sí mismo— de que un match aproximado equivocado es peor que ninguno. El
 * problema es que el costo del otro lado no se había medido: **"facturale a
 * perez 2 bolsas a 6500" caía en "no entendí"**, y con él nueve de cada diez
 * transcripciones de audio ("acele una fatura a peres", "kien me deve plata",
 * "komo biene el mes"). Alguien que dicta un audio no está escribiendo mal: está
 * usando el canal como se usa WhatsApp.
 *
 * La tolerancia va en el ÚLTIMO paso, después de exacto y de inclusión, así que
 * no le puede ganar a nada seguro; se limita a palabras de 4 letras o más con
 * largos parecidos; y el resultado sale marcado `aproximado` con su confianza,
 * que es lo que permite al agente repreguntar en vez de afirmar.
 */
function puntajeTokens(tokensMensaje: readonly string[], sinonimo: string): number {
  const tokensSin = tokenizar(normalizarTexto(sinonimo));
  if (tokensSin.length === 0) return 0;
  const presentes = tokensSin.filter((ts) =>
    tokensMensaje.some((tm) => tokenCoincide(tm, ts)),
  ).length;
  return presentes / tokensSin.length;
}

/** Mínimo de coincidencia para aceptar un match aproximado. */
const UMBRAL_APROXIMADO = 0.6;

/**
 * Cuánto se puede parecer una palabra mal escrita a una palabra del catálogo.
 *
 * 0.75 de similitud de edición: "fatura"→"factura" (0.86), "deve"→"debe" (0.75),
 * "kien"→"quien" (0.6, NO entra por edición pero sí por el token vecino).
 * Bajarlo más empieza a unir palabras distintas — "cobrar" y "cobrar" contra
 * "comprar" están a una letra— y ese error es peor que no entender: manda al
 * usuario a la respuesta de otra pregunta.
 */
const UMBRAL_EDICION = 0.75;

/** Palabras de menos de esto no se comparan por edición: todo se parece a todo. */
const LARGO_MINIMO_EDICION = 4;

/**
 * ¿Este token del mensaje es "el mismo" que este token del sinónimo?
 *
 * Exacto primero (barato y seguro), y recién después por distancia de edición.
 * El orden importa: un match exacto nunca puede perder contra uno aproximado.
 */
function tokenCoincide(tokenMensaje: string, tokenSinonimo: string): boolean {
  if (tokenMensaje === tokenSinonimo) return true;
  if (tokenMensaje.length < LARGO_MINIMO_EDICION || tokenSinonimo.length < LARGO_MINIMO_EDICION) {
    return false;
  }
  // Una diferencia de largo grande no es un typo, es otra palabra.
  if (Math.abs(tokenMensaje.length - tokenSinonimo.length) > 2) return false;
  return similitudEdicion(tokenMensaje, tokenSinonimo) >= UMBRAL_EDICION;
}

/** Normaliza para comparar: minúsculas, sin tildes, sin signos, sin espacios de más. */
export function normalizarTexto(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MenuOpciones {
  capabilityMode?: BillerCapabilityMode;
  /** Nombre de la empresa, para el encabezado. Opcional. */
  empresa?: string;
  /**
   * true cuando hay una emisión guiada A MEDIO CARGAR en esta conversación.
   *
   * Cambia el default del enrutador: en el mostrador, "pará, eran 3 no 2" o
   * "que sean bolsas de 25kg" son correcciones del borrador — pero un enrutador
   * sin contexto las mandaba a "no entendí" y devolvía el menú en medio de la
   * carga. Con esto, lo que no matchea NADA se enruta como respuesta del flujo
   * (`flujo_emision`) en vez de como desconocido.
   *
   * Lo que SÍ matchea sigue ganando: "menú" saca del flujo a propósito,
   * "cancelá" frena, "dale" afirma. El flujo no captura la conversación; solo
   * cambia qué significa el silencio del catálogo.
   */
  en_flujo?: boolean;
}

/**
 * Las opciones que se pueden ofrecer de verdad.
 *
 * En `read_only` la emisión no está registrada: mostrarla llevaría a una
 * conversación entera de recolección de datos que termina en "esa tool no
 * existe". Una opción que no se puede cumplir es peor que una opción menos.
 */
export function opcionesDisponibles(opciones: MenuOpciones = {}): MenuOpcion[] {
  return intencionesDisponibles(opciones).filter((o) => o.oculta !== true);
}

/**
 * Todo lo que el enrutador puede reconocer: las filas del menú MÁS las
 * intenciones ocultas.
 *
 * La diferencia con `opcionesDisponibles` es la que separa la vidriera del
 * catálogo. Lo que se muestra tiene un límite duro de 10 filas; lo que se
 * entiende, no. Confundirlos era la razón por la que "¿qué productos vendo
 * más?" no llegaba a `biller_ranking_productos`, que está registrada y anda.
 */
export function intencionesDisponibles(opciones: MenuOpciones = {}): MenuOpcion[] {
  const escritura = opciones.capabilityMode === "write_enabled";
  return OPCIONES_MENU.filter((o) => escritura || o.requiereEscritura !== true);
}

/**
 * Interpreta lo que mandó el usuario.
 *
 * Tres formas de elegir, todas soportadas: tocar la fila (llega el `id`),
 * escribir el número de la lista, o escribir con sus palabras. La tercera es la
 * que realmente se usa; las dos primeras son las que no fallan.
 */
export interface Interpretacion {
  /** La opción elegida, si se pudo determinar. */
  opcion: MenuOpcion | null;
  /**
   * Cómo se determinó.
   * - `saludo`: no eligió nada, mostrale el menú.
   * - `cortesia`: dijo "gracias"/"dale". No hay nada que buscar; se acusa recibo.
   * - `aproximado`: se parece a una opción, pero no es seguro. Mirá `confianza`.
   * - `ambiguo`: apunta a dos opciones. Mirá `candidatas` y preguntá cuál.
   * - `no_disponible`: la opción existe pero el server no la tiene habilitada.
   * - `emision_confirmada` / `emision_cancelada`: tocó ✅ o ✖️ en el preview.
   * - `flujo_emision`: es una respuesta de la emisión guiada, no del menú.
   * - `pedido_emision`: no matcheó ningún sinónimo, pero el texto ES un pedido
   *   de facturación con datos adentro. Ver `extraerPedido.ts`.
   */
  via:
    | "id"
    | "numero"
    | "sinonimo"
    | "aproximado"
    | "ambiguo"
    | "saludo"
    | "cortesia"
    | "no_disponible"
    | "emision_confirmada"
    | "emision_cancelada"
    | "flujo_emision"
    | "pedido_emision"
    | "resolucion_elegida"
    | "afirmacion"
    | "cancelacion"
    | "desconocido";
  /** true si corresponde mandar el menú. */
  mostrar_menu: boolean;
  /**
   * Las opciones entre las que hay que elegir cuando `via` es "ambiguo".
   * Siempre 2 o más, y como máximo 3: es lo que entra en botones de WhatsApp.
   */
  candidatas?: MenuOpcion[];
  /** El `confirmation_token` que venía adentro del botón ✅, ya sin el prefijo. */
  confirmation_token?: string;
  /**
   * Qué contestar cuando no hay tool que llamar. Existe para que NINGÚN camino
   * termine sin respuesta: un mensaje sin respuesta es el peor resultado
   * posible de este flujo, peor que una respuesta imperfecta.
   */
  respuesta_sugerida?: string;
  /** Coincidencia 0..1 cuando `via` es "aproximado". */
  confianza?: number;
  /**
   * Qué eligió el usuario en la desambiguación de `biller_resolver_nombre`.
   * `indice` es la posición dentro del array `candidatos` de ESA respuesta.
   */
  resolucion?: { tipo: "cliente" | "producto"; indice: number };
  /**
   * Cuando `via` es "pedido_emision": QUÉ CAMPOS trae el mensaje, por nombre.
   *
   * Nombres, nunca valores. El concepto de un ítem es texto libre y su clave
   * está en `CAMPOS_NO_CONFIABLES`: devolverlo acá lo haría salir envuelto en
   * ⟦dato-no-confiable⟧ por la barrera y volvería a entrar así al borrador.
   * Los VALORES los vuelve a leer `biller_emision_guiada`, del lado del server,
   * con el mismo extractor — que es lo que hace que el resultado no dependa de
   * que el modelo los haya copiado bien.
   */
  pedido_campos?: string[];
}

/**
 * Resultado de buscar el texto del usuario contra un conjunto de opciones.
 *
 * `empate` no es un fracaso: es información. Significa que el mensaje apunta a
 * dos cosas distintas y que hay exactamente una pregunta corta que lo resuelve.
 * Devolver las candidatas permite preguntarla; devolver `null` obligaba a
 * contestar el menú entero, que es hacerle releer diez opciones a alguien que
 * ya escribió lo que quería.
 */
type Busqueda =
  | { clase: "hit"; opcion: MenuOpcion; via: "sinonimo" | "aproximado"; confianza: number }
  | { clase: "empate"; opciones: MenuOpcion[] }
  | null;

/**
 * Una palabra suelta ("emitir", "clientes", "pdf") no se busca como subcadena:
 * tiene que aparecer como PALABRA en el mensaje.
 *
 * El caso que lo motivó no es teórico. El id que llega cuando el usuario toca
 * ✖️ Cancelar es "emitir:no", que contiene la cadena "emitir": el enrutador lo
 * leía como "quiere emitir" y reabría el flujo que el usuario acababa de
 * cancelar. Una frase de varias palabras sí se busca como subcadena — es
 * específica por sí misma, y ahí el riesgo no existe.
 */
function esPalabraSuelta(sinonimoNorm: string): boolean {
  return !sinonimoNorm.includes(" ");
}

/**
 * Un sinónimo que, sacándole las palabras vacías, se reduce a UNA sola palabra
 * no sirve para puntuar por tokens: matchea al 100% cualquier frase que la
 * contenga.
 *
 * Esto también salió de fallas reales y silenciosas: "me pagaron la factura
 * 1234" matcheaba "Mandar un comprobante" al 100% —porque "pasame la factura"
 * se reduce a "factura"— y el usuario recibía el PDF de una factura cuando
 * estaba avisando que se la habían pagado. Una respuesta segura de sí misma a
 * una pregunta que nadie hizo.
 *
 * Para la comparación por SUBCADENA esos sinónimos siguen valiendo: ahí se
 * compara la frase textual, no sus palabras sueltas.
 */
function esDebilPorTokens(sinonimoNorm: string): boolean {
  return tokenizar(sinonimoNorm).length < 2;
}

/**
 * Palabras que dan vuelta el sentido de lo que sigue.
 *
 * "no me pagaron todavía" contiene "me pagaron", que es sinónimo-frase de
 * "Registrar un cobro" — una tool de ESCRITURA. O sea: el usuario avisaba que
 * NO le habían pagado y el sistema lo llevaba a emitir un recibo, con seguridad
 * total y sin warning. La subcadena no alcanza como evidencia cuando adelante
 * hay un negador.
 */
const NEGADORES = new Set(["no", "nunca", "nadie", "todavia", "aun", "sin", "tampoco"]);

/**
 * ¿Hay un negador en las dos palabras anteriores a donde matcheó el sinónimo?
 *
 * Dos y no más: "no me pagaron" y "todavía no me pagaron" quedan adentro,
 * mientras que un "no" a diez palabras de distancia (otra oración) no invalida
 * nada.
 */
function negadoAntesDe(norm: string, sinonimo: string): boolean {
  const pos = norm.indexOf(sinonimo);
  if (pos <= 0) return false;
  const previas = norm.slice(0, pos).trim().split(" ").filter((t) => t !== "");
  return previas.slice(-2).some((t) => NEGADORES.has(t));
}

/** Busca en un conjunto de opciones por sinónimo exacto, inclusión y tokens. */
function buscarPorTexto(norm: string, candidatas: readonly MenuOpcion[]): Busqueda {
  const tokens = tokenizar(norm);

  // a. Igualdad exacta con un sinónimo: lo más barato y lo más confiable.
  for (const o of candidatas) {
    if (o.sinonimos.some((s) => normalizarTexto(s) === norm)) {
      return { clase: "hit", opcion: o, via: "sinonimo", confianza: 1 };
    }
  }

  // b. Inclusión, del sinónimo más largo al más corto: "nota de credito" tiene
  //    que ganarle a "credito" si ambos existen.
  //
  //    La inclusión es por PALABRA COMPLETA para los sinónimos de una palabra.
  //    Sin eso, el id "emitir:no" —lo que llega cuando el usuario toca ✖️
  //    Cancelar— contenía la cadena "emitir" y el enrutador lo leía como
  //    "quiere emitir": cancelar reabría el flujo que se acababa de cancelar.
  const inclusiones = candidatas
    .flatMap((o) => o.sinonimos.map((s) => ({ opcion: o, sinonimo: normalizarTexto(s) })))
    .filter((c) => {
      if (c.sinonimo === "") return false;
      const matchea = esPalabraSuelta(c.sinonimo)
        ? tokens.includes(c.sinonimo)
        : norm.includes(c.sinonimo);
      // Un negador adelante da vuelta el sentido: ver `negadoAntesDe`.
      return matchea && !negadoAntesDe(norm, c.sinonimo);
    })
    .sort((a, b) => b.sinonimo.length - a.sinonimo.length);

  const mejorInclusion = inclusiones[0];
  if (mejorInclusion !== undefined) {
    // Cuando lo mejor que matcheó es una palabra suelta, la longitud NO es
    // evidencia: "qué clientes están en deuda" toca "clientes" y "deuda", y que
    // una tenga tres letras más no dice nada sobre qué quiso preguntar. Dos
    // palabras genéricas apuntando a intenciones distintas es la definición de
    // ambigüedad, y se pregunta.
    //
    // Si lo mejor es una FRASE, gana la más larga y no hay empate que resolver:
    // "nota de credito" tiene que ganarle a "credito", que es justamente el
    // caso para el que existe el orden por longitud.
    if (esPalabraSuelta(mejorInclusion.sinonimo)) {
      const sueltas = dedupOpciones(
        inclusiones.filter((c) => esPalabraSuelta(c.sinonimo)).map((c) => c.opcion),
      );
      if (sueltas.length > 1) return { clase: "empate", opciones: sueltas };
    }

    // DOS FRASES DE OPCIONES DISTINTAS TAMBIÉN SON UN EMPATE.
    //
    // El orden por longitud existe para el caso ANIDADO ("nota de credito" tiene
    // que ganarle a "credito"), y ahí sigue valiendo. Pero cuando las dos frases
    // son independientes, la longitud no decide nada: "cuánto compré y cuánto
    // vendí" se resolvía por UN carácter de diferencia entre los dos sinónimos,
    // en silencio y con confianza 1. Son dos preguntas en un mensaje, y eso se
    // pregunta.
    const independientes = dedupOpciones(
      inclusiones
        .filter(
          (c) =>
            !esPalabraSuelta(c.sinonimo) &&
            !mejorInclusion.sinonimo.includes(c.sinonimo) &&
            !c.sinonimo.includes(mejorInclusion.sinonimo),
        )
        .map((c) => c.opcion)
        .filter((o) => o.id !== mejorInclusion.opcion.id),
    );
    if (independientes.length > 0) {
      return { clase: "empate", opciones: [mejorInclusion.opcion, ...independientes] };
    }

    return { clase: "hit", opcion: mejorInclusion.opcion, via: "sinonimo", confianza: 1 };
  }

  // c. Coincidencia por palabras con contenido. Esto es lo que hace que
  //    "¿cómo dieron el mes?" llegue a "¿cómo viene el mes?" y que "¿qué MÁS
  //    podés hacer?" llegue a la ayuda: dos preguntas que antes caían en
  //    "no entendí" por una palabra de diferencia.
  if (tokens.length === 0) return null;

  const puntajes = candidatas
    .map((o) => ({
      opcion: o,
      puntaje: Math.max(
        0,
        ...o.sinonimos
          .map((s) => normalizarTexto(s))
          .filter((s) => !esDebilPorTokens(s))
          .map((s) => puntajeTokens(tokens, s)),
      ),
    }))
    .sort((a, b) => b.puntaje - a.puntaje);

  const mejor = puntajes[0];
  if (mejor === undefined || mejor.puntaje < UMBRAL_APROXIMADO) return null;

  // Empate entre dos opciones distintas = no se sabe. Antes esto devolvía el
  // menú entero; ahora devuelve las candidatas, que es lo que hace falta para
  // preguntar "¿cuál de estas dos?" en vez de empezar de cero.
  const empatados = puntajes.filter((p) => p.puntaje === mejor.puntaje).map((p) => p.opcion);
  if (empatados.length > 1) return { clase: "empate", opciones: dedupOpciones(empatados) };

  return { clase: "hit", opcion: mejor.opcion, via: "aproximado", confianza: mejor.puntaje };
}

function dedupOpciones(opciones: readonly MenuOpcion[]): MenuOpcion[] {
  const vistos = new Set<string>();
  return opciones.filter((o) => (vistos.has(o.id) ? false : (vistos.add(o.id), true)));
}

export function interpretarMensaje(raw: string, opciones: MenuOpciones = {}): Interpretacion {
  const disponibles = opcionesDisponibles(opciones);
  const intenciones = intencionesDisponibles(opciones);
  const texto = raw.trim();

  // 0. Los ids que emitimos NOSOTROS en otros mensajes.
  //
  //    Esto va primero y sin pasar por ninguna heurística. El enrutador es el
  //    punto de entrada de TODO lo que escribe el usuario, incluidos los
  //    botones de la emisión guiada y los del preview — que llegan como texto,
  //    igual que "hola". Antes caían en el matching por palabras, con dos
  //    consecuencias feas y silenciosas: "emitir:no" (tocar ✖️ Cancelar) se
  //    leía como "quiere emitir" y reabría el flujo recién cancelado, y
  //    "emision:iva:3" no matcheaba nada y devolvía el menú, tirando a la
  //    basura una conversación de seis mensajes.
  const respuestaEmision = interpretarRespuestaEmision(texto);
  if (respuestaEmision.accion === "emitir") {
    return {
      opcion: null,
      via: "emision_confirmada",
      mostrar_menu: false,
      confirmation_token: respuestaEmision.token,
      respuesta_sugerida: "Dale, lo emito.",
    };
  }
  if (respuestaEmision.accion === "cancelar") {
    return {
      opcion: null,
      via: "emision_cancelada",
      mostrar_menu: false,
      respuesta_sugerida:
        "Listo, no emití nada. El comprobante quedó sin emitir. Cuando quieras lo retomamos.",
    };
  }
  const resolucion = interpretarRespuestaResolucion(texto);
  if (resolucion !== null) {
    return {
      opcion: null,
      via: "resolucion_elegida",
      mostrar_menu: false,
      resolucion,
      respuesta_sugerida: "Dale, sigo con ese.",
    };
  }
  if (texto.startsWith(PREFIJO_PASO)) {
    return {
      opcion: OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`) ?? null,
      via: "flujo_emision",
      mostrar_menu: false,
    };
  }

  // 1. Id exacto: viene de que el usuario tocó una fila O un botón.
  //
  //    Se busca contra `intenciones` (el catálogo) y NO contra `disponibles`
  //    (la vidriera). La distinción vidriera/catálogo aplica a lo que se MUESTRA
  //    y a la numeración; un id que VUELVE es catálogo por definición: se lo
  //    mandamos nosotros.
  //
  //    Con `disponibles` acá pasaba esto, y es peor que un bug: "dar de alta"
  //    devuelve ambiguo entre dos intenciones ocultas, `construirDesambiguacion`
  //    manda los dos botones, el usuario toca uno... y el paso 1b concluía "esa
  //    opción no está habilitada, el server está en modo consulta" — con el
  //    server en write_enabled. Le mandamos un botón y cuando lo toca le
  //    mentimos.
  const porId = intenciones.find((o) => o.id === texto);
  if (porId !== undefined) return { opcion: porId, via: "id", mostrar_menu: false };

  // 1b. Un id que existe en el catálogo pero NO está habilitado. Sin esta rama
  //     caía en "no entendí" y el usuario recibía el menú de vuelta sin que
  //     nadie le dijera nunca por qué la opción que tocó no hizo nada.
  const porIdNoDisponible = OPCIONES_MENU.find((o) => o.id === texto);
  if (porIdNoDisponible !== undefined) {
    return {
      opcion: porIdNoDisponible,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(porIdNoDisponible),
    };
  }

  const norm = normalizarTexto(texto);
  if (norm === "") return { opcion: null, via: "desconocido", mostrar_menu: true };

  // 2. Número de la lista tal como se le mostró.
  //
  //    SALVO en medio de la emisión: ahí "3" contesta "¿cuántos?" y no elige la
  //    fila 3 del menú. El flujo tiene prioridad sobre la numeración porque la
  //    pregunta abierta es del flujo. (Se saltea el paso entero: el texto sigue
  //    hasta el fallback de flujo del final.)
  //
  //    Se acepta con palabras vacías alrededor: "la 4", "opción 3", "el 2",
  //    "2 por favor". Antes el regex corría sobre `norm` COMPLETO, así que las
  //    cuatro caían en "no entendí" y devolvían el menú a alguien que ya había
  //    elegido. Se exige que quede UN SOLO token con contenido, así "3 chapas" o
  //    "anular la 456" no se tragan como elección de menú.
  const tokensNum = tokenizar(norm);
  if (opciones.en_flujo !== true && tokensNum.length === 1 && /^\d{1,2}$/.test(tokensNum[0]!)) {
    const idx = Number(tokensNum[0]!) - 1;
    const porNumero = disponibles[idx];
    if (porNumero !== undefined) return { opcion: porNumero, via: "numero", mostrar_menu: false };
    return {
      opcion: null,
      via: "desconocido",
      mostrar_menu: true,
      respuesta_sugerida:
        `Ese número no está en la lista: hay ${disponibles.length} opciones. Te la mando de nuevo.`,
    };
  }

  // 2b. Afirmación o cancelación escritas.
  //
  //     Van ANTES de los sinónimos: "dale" y "pará" no significan nada para el
  //     menú, pero lo significan todo para el paso que estaba pendiente.
  if (AFIRMACIONES.includes(norm) || ASENTIMIENTOS.includes(norm)) {
    return {
      opcion: null,
      via: "afirmacion",
      mostrar_menu: false,
      respuesta_sugerida:
        "El usuario dijo que sí. Aplicalo al paso que estabas esperando —confirmar la emisión, " +
        "elegir un candidato, cerrar los ítems— y seguí. NO mandes el menú: no está eligiendo una " +
        "opción, está contestando tu última pregunta. Si no había ninguna pregunta abierta, es un " +
        "\"dale\" de cortesía: acusá recibo corto y listo, no preguntes nada. OJO: si el paso " +
        "pendiente era emitir, necesitás " +
        "el confirmation_token del dry-run; un 'sí' escrito no reemplaza al token.",
    };
  }
  if (CANCELACIONES.includes(norm) || NEGACIONES_SECAS.includes(norm)) {
    return {
      opcion: null,
      via: "cancelacion",
      mostrar_menu: false,
      respuesta_sugerida:
        "El usuario dijo que no. NO emitas ni ejecutes nada de lo que estaba pendiente; si había " +
        "algo, confirmale en una línea que quedó sin hacer. Si no había nada pendiente, es un " +
        "\"no\" a tu última pregunta: tomalo como respuesta y seguí. No mandes el menú: decir que " +
        "no, no es pedir opciones.",
    };
  }

  // 3. Saludo o pedido explícito de menú. Va ANTES de los sinónimos: "menu" no
  //    debe matchear "¿qué más podés hacer?" por contener la palabra opciones.
  if (SALUDOS.includes(norm)) return { opcion: null, via: "saludo", mostrar_menu: true };

  // 4. Cortesía: no hay nada que buscar y el menú sería una respuesta grosera.
  if (CORTESIAS.includes(norm)) {
    return {
      opcion: null,
      via: "cortesia",
      mostrar_menu: false,
      respuesta_sugerida: "Dale, cualquier cosa escribime. Si querés ver las opciones, mandá \"menú\".",
    };
  }

  // 5. Palabras del usuario, contra TODO lo que se puede contestar (filas del
  //    menú + intenciones ocultas) y contra lo que está apagado.
  //
  //    Las dos búsquedas se comparan por CALIDAD, no por orden. Antes ganaba
  //    siempre lo disponible, y por eso "necesito hacer una boleta" en modo
  //    lectura terminaba en "¿Qué más podés hacer?" —un match flojo pero
  //    disponible— en vez de decir la verdad: que en modo consulta no se emite.
  //    Un parecido lejano no le puede ganar a una coincidencia exacta solo por
  //    estar habilitada.
  const noDisponibles = OPCIONES_MENU.filter((o) => !intenciones.includes(o));
  const hit = buscarPorTexto(norm, intenciones);
  const hitBloqueado = noDisponibles.length === 0 ? null : buscarPorTexto(norm, noDisponibles);

  if (hitBloqueado !== null && calidad(hitBloqueado) > calidad(hit)) {
    const opcion = hitBloqueado.clase === "hit" ? hitBloqueado.opcion : hitBloqueado.opciones[0]!;
    return {
      opcion,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(opcion),
    };
  }

  if (hit !== null) {
    if (hit.clase === "empate") {
      // Dos intenciones distintas, una pregunta corta que las separa. Ver
      // `construirDesambiguacion`.
      const candidatas = hit.opciones.slice(0, 3);
      return {
        opcion: null,
        via: "ambiguo",
        mostrar_menu: false,
        candidatas,
        respuesta_sugerida: `¿Cuál de estas necesitás: ${candidatas
          .map((o) => `"${o.titulo}"`)
          .join(" o ")}?`,
      };
    }
    return {
      opcion: hit.opcion,
      via: hit.via,
      mostrar_menu: false,
      ...(hit.via === "aproximado" ? { confianza: hit.confianza } : {}),
    };
  }

  // 6. ¿Pedía algo que existe pero está deshabilitado? Decirlo es la diferencia
  //    entre "no se puede acá" y el silencio.
  if (hitBloqueado !== null) {
    const opcion = hitBloqueado.clase === "hit" ? hitBloqueado.opcion : hitBloqueado.opciones[0]!;
    return {
      opcion,
      via: "no_disponible",
      mostrar_menu: false,
      respuesta_sugerida: motivoNoDisponible(opcion),
    };
  }

  // 6b. En medio de la emisión, lo que no matcheó NADA es una respuesta del
  //     flujo, no un desconocido. "pará, eran 3 no 2", "que sean de 25kg",
  //     "el rut es 21..." — el catálogo no las conoce y no tiene por qué:
  //     la pregunta abierta es del flujo, y el que sabe aplicarlas es
  //     biller_emision_guiada con el borrador adelante. Devolver el menú acá
  //     era tirar a la basura una carga a medio hacer.
  if (opciones.en_flujo === true) {
    return {
      opcion: OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`) ?? null,
      via: "flujo_emision",
      mostrar_menu: false,
    };
  }

  // 6c. ¿ES UN PEDIDO DE FACTURACIÓN AUNQUE NO SE PAREZCA A NINGÚN SINÓNIMO?
  //
  //     "perez 2 bolsas portland 6500" no matchea nada del catálogo y es una
  //     orden de facturar perfectamente clara. El catálogo compara contra
  //     FRASES; un pedido real trae un cliente, una cantidad y un precio, y eso
  //     no se puede enumerar. `extraerPedido.ts` lo lee con una gramática, y
  //     con dos campos adentro ya no hay ambigüedad sobre qué se está pidiendo.
  //
  //     VA ÚLTIMO Y NO PRIMERO, a propósito: cualquier coincidencia del
  //     catálogo —exacta, por inclusión o por parecido— le gana, igual que le
  //     gana la rama del flujo. El extractor no compite con el enrutador; se
  //     queda con lo que el enrutador iba a tirar a "no entendí".
  const pedido = extraerPedidoEmision(texto);
  if (esPedidoDeEmision(pedido)) {
    const emitir = OPCIONES_MENU.find((o) => o.id === `${PREFIJO_MENU}emitir`);
    if (emitir !== undefined) {
      // En modo consulta la emisión no existe, y decirlo es mejor que abrir un
      // flujo que no puede terminar. Misma regla que el resto del enrutador.
      if (!intenciones.includes(emitir)) {
        return {
          opcion: emitir,
          via: "no_disponible",
          mostrar_menu: false,
          respuesta_sugerida: motivoNoDisponible(emitir),
        };
      }
      return {
        opcion: emitir,
        via: "pedido_emision",
        mostrar_menu: false,
        pedido_campos: pedido.campos,
      };
    }
  }

  // 7. No se entendió. El menú es mejor respuesta que "no te entendí" — pero
  //    NO es lo mismo que "no se puede contestar": la tool avisa al agente que
  //    una pregunta concreta de facturación se contesta igual.
  return { opcion: null, via: "desconocido", mostrar_menu: true };
}

/**
 * Cuán buena es una búsqueda, para poder comparar dos conjuntos de candidatas.
 * Exacto/inclusión (2) > empate (1.5) > parecido (1) > nada (0).
 */
function calidad(b: Busqueda): number {
  if (b === null) return 0;
  if (b.clase === "empate") return 1.5;
  return b.via === "sinonimo" ? 2 : 1;
}

/** Por qué una opción del catálogo no está habilitada, en castellano. */
/**
 * POR QUÉ ESTE TEXTO LE HABLA AL USUARIO Y NO AL AGENTE.
 *
 * `respuesta_sugerida` tiene dos destinos, y solo uno tiene un modelo en el
 * medio: la tool (`biller_menu_whatsapp`) se la da al agente para que redacte,
 * pero el webhook la manda TAL CUAL por WhatsApp cuando la vía es
 * autorespondible — y `no_disponible` lo es. La versión anterior decía
 * "BILLER_CAPABILITY_MODE=read_only" y "Decile al usuario eso": el dueño del
 * almacén recibía el nombre de una variable de entorno y una orden dirigida a
 * otro. La regla que queda: toda `respuesta_sugerida` de una vía
 * autorespondible se escribe para el usuario final; el encuadre para el agente
 * vive en `menuWhatsapp.ts`, que es el único lugar donde hay un agente leyendo.
 */
function motivoNoDisponible(opcion: MenuOpcion): string {
  if (opcion.requiereEscritura === true) {
    return (
      `Por ahora este canal es solo de consulta: puedo mostrarte todo lo que ya está emitido ` +
      `—ventas, deudas, vencimientos— pero no ${opcion.titulo.toLowerCase()}. Para habilitar esa ` +
      "parte hay que activarla en el servidor; habla con quien te lo configuró."
    );
  }
  return `"${opcion.titulo}" no está habilitada en este canal. Escribime "menú" y te muestro lo que sí puedo.`;
}

/** Menú como lista interactiva de WhatsApp. */
export function construirMenuInteractivo(opciones: MenuOpciones = {}): InteractivoLista {
  const disponibles = opcionesDisponibles(opciones);
  // Mismo orden que OPCIONES_MENU: Facturar primero. Si estos dos órdenes se
  // separan, el número que el usuario escribe deja de coincidir con la fila que
  // ve — que es justamente lo que la numeración existe para evitar.
  const grupos: MenuOpcion["grupo"][] = ["Facturar", "Plata", "Números", "Otros"];

  const secciones = grupos
    .map((grupo) => ({
      titulo: grupo,
      filas: disponibles
        .filter((o) => o.grupo === grupo)
        .map((o) => ({ id: o.id, titulo: o.titulo, descripcion: o.descripcion })),
    }))
    .filter((s) => s.filas.length > 0);

  return {
    tipo: "lista",
    encabezado: opciones.empresa === undefined ? "Biller" : `Biller · ${opciones.empresa}`,
    cuerpo:
      "Hola 👋 Soy el asistente de tu facturación. Preguntame lo que quieras con tus palabras, " +
      "o elegí una opción de la lista.",
    pie: "Los números salen de tus comprobantes en Biller.",
    boton: "Ver opciones",
    secciones,
  };
}

/**
 * La pregunta que resuelve un empate, como botones.
 *
 * Es la alternativa a las dos malas salidas que había antes: elegir una de las
 * dos al azar (y contestar con seguridad la pregunta que el usuario no hizo) o
 * devolver el menú entero (y hacerle releer diez opciones a alguien que ya
 * escribió lo que quería). Acá se le devuelve exactamente lo que él dijo,
 * separado en las dos cosas que puede significar, a un toque de distancia.
 *
 * Los ids son los mismos `menu:*` de siempre: la respuesta vuelve por el mismo
 * camino que una fila del menú y no hace falta ningún estado intermedio.
 */
export function construirDesambiguacion(candidatas: readonly MenuOpcion[]): InteractivoBotones {
  const elegidas = candidatas.slice(0, 3);
  return {
    tipo: "botones",
    cuerpo:
      elegidas.length === 0
        ? "¿Qué necesitás?"
        : "Puede ser una de estas dos cosas y no quiero contestarte la que no era 🙂\n\n¿Cuál es?",
    botones: elegidas.map((o) => ({ id: o.id, titulo: o.titulo.slice(0, 20) })),
  };
}

/**
 * Mismo menú en texto plano.
 *
 * No es un fallback decorativo: es lo que se usa cuando el que contesta es el
 * Agent Node de Kapso (que responde texto), y también cuando el interactivo se
 * rechaza. La numeración coincide con el orden de `opcionesDisponibles`, que es
 * lo que hace que "3" signifique lo mismo en los dos formatos.
 */
export function construirMenuTexto(opciones: MenuOpciones = {}): string {
  const disponibles = opcionesDisponibles(opciones);
  const lineas = [
    "👋 Hola, soy el asistente de tu facturación.",
    "",
    "Preguntame con tus palabras, o mandá el número:",
    "",
    ...disponibles.map((o, i) => `${i + 1}. *${o.titulo}* — ${o.descripcion}`),
  ];
  if (opciones.capabilityMode !== "write_enabled") {
    lineas.push("", "_Modo consulta: puedo mirar, todavía no emitir._");
  }
  return lineas.join("\n");
}

// --- Confirmación de emisión ------------------------------------------------

/**
 * El preview de emisión como dos botones.
 *
 * El `confirmation_token` viaja DENTRO del id del botón. Eso es lo que hace que
 * tocar "Emitir" sea lo mismo que confirmar el preview exacto que se leyó: el
 * token está ligado al payload por hash, así que no hay forma de que el botón
 * confirme algo distinto de lo que dice el mensaje.
 *
 * El texto del cuerpo lo arma esta función a partir de números YA CALCULADOS en
 * TypeScript. Si el resumen lo redactara el modelo, el importe que el usuario
 * aprueba y el que se emite podrían no ser el mismo — y el usuario no tendría
 * cómo notarlo.
 */
export function construirConfirmacionEmision(datos: {
  /** El cuerpo ya formateado: ítems, IVA, total y supuestos. Ver `formatearTotales`. */
  resumen: string;
  cliente?: string;
  /** RUT o CI del receptor. Se enmascara. */
  documento?: string;
  tipoComprobante?: string;
  ambiente: "test" | "production";
  token: string;
}): InteractivoBotones {
  // El encabezado dice a QUIÉN, y va arriba de todo: el error más caro de una
  // emisión no es el total, es el cliente. Antes el nombre iba después de los
  // números, donde se lee último o no se lee.
  const quien = datos.cliente === undefined || datos.cliente.trim() === "" ? "" : datos.cliente.trim();
  const encabezado =
    (datos.tipoComprobante ?? "Comprobante") + (quien === "" ? "" : ` a ${quien}`);

  const lineas = [encabezado];
  const doc = enmascararDocumento(datos.documento);
  if (doc !== null) lineas.push(doc);
  lineas.push("", datos.resumen, "", "¿Lo emito?");

  return {
    tipo: "botones",
    cuerpo: lineas.join("\n"),
    pie:
      datos.ambiente === "production"
        ? "⚠️ PRODUCCIÓN: se emite ante DGI de verdad."
        : "Ambiente de prueba (no va a DGI real).",
    // TRES BOTONES, QUE ES EL MÁXIMO DE WHATSAPP.
    //
    // El tercero reemplaza dos pasos enteros del flujo (`otro_item` y `adenda`)
    // por una opción que solo paga el que la usa. Antes, agregar una segunda
    // línea costaba una pregunta a TODAS las emisiones — incluidas las de una
    // sola línea, que son la mayoría. Acá el que quiere agregar toca; el que no,
    // ni se entera de que existía la pregunta.
    //
    // Al tocarlo se abre un ítem vacío y el flujo pide su concepto y su precio;
    // después vuelve a este mismo preview, con el token recalculado sobre el
    // payload nuevo. El ciclo dry-run → token → confirm no cambia en nada.
    botones: [
      { id: `${PREFIJO_EMISION}si:${datos.token}`, titulo: "✅ Emitir" },
      { id: `${PREFIJO_PASO}item:otro`, titulo: "➕ Otro ítem" },
      { id: `${PREFIJO_EMISION}no`, titulo: "✖️ Cancelar" },
    ],
  };
}

/**
 * "219999830019" -> "RUT 21…0011". null si no hay documento.
 *
 * Mismo criterio que el enmascarado del `payload_preview` (write/shared.ts):
 * queda suficiente para reconocer al cliente y no para copiarlo entero. Acá
 * pesa además que el mensaje va por WhatsApp, o sea que queda en el teléfono.
 */
function enmascararDocumento(bruto: string | undefined): string | null {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  if (digitos.length < 7) return null;
  const etiqueta = digitos.length === 12 ? "RUT" : "CI";
  return `${etiqueta} ${digitos.slice(0, 2)}…${digitos.slice(-4)}`;
}

/**
 * Lee el botón de desambiguación: "resolver:cliente:1" -> el segundo candidato.
 *
 * Devuelve null para todo lo que no reconoce, para que un id mal formado siga su
 * camino por el enrutador en vez de cortar la conversación.
 */
export function interpretarRespuestaResolucion(
  raw: string,
): { tipo: "cliente" | "producto"; indice: number } | null {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_RESOLVER)) return null;
  const partes = texto.slice(PREFIJO_RESOLVER.length).split(":");
  const tipo = partes[0];
  const indice = Number(partes[1]);
  if (tipo !== "cliente" && tipo !== "producto") return null;
  if (!Number.isInteger(indice) || indice < 0) return null;
  return { tipo, indice };
}

export type RespuestaEmision =
  | { accion: "emitir"; token: string }
  | { accion: "cancelar" }
  | { accion: "ninguna" };

/** Lee la respuesta a la confirmación. El token vuelve tal cual se mandó. */
export function interpretarRespuestaEmision(raw: string): RespuestaEmision {
  const texto = raw.trim();
  if (!texto.startsWith(PREFIJO_EMISION)) return { accion: "ninguna" };
  const resto = texto.slice(PREFIJO_EMISION.length);
  if (resto === "no") return { accion: "cancelar" };
  if (resto.startsWith("si:")) {
    const token = resto.slice(3);
    return token === "" ? { accion: "ninguna" } : { accion: "emitir", token };
  }
  return { accion: "ninguna" };
}
