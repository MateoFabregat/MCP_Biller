// =============================================================================
// El catálogo: qué se puede pedir, y con qué palabras se pide.
//
// Datos, no algoritmo. Acá viven las opciones del menú —con sus ids, sus tools y
// sus sinónimos— y los léxicos sueltos que el enrutador consulta (saludos,
// cortesías, afirmaciones, cancelaciones, palabras vacías). Cómo se compara un
// mensaje contra todo esto es asunto de `enrutador.ts`; cómo se dibuja, de
// `render.ts`.
//
// La separación se paga sola cuando hay que agregar una intención: se toca este
// archivo y nada más. Y al revés: un cambio en el matching no puede cambiar sin
// querer qué opciones existen.
// =============================================================================

import type { BillerCapabilityMode } from "../config.js";
import { PREFIJO_MENU } from "./protocolo.js";

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
      // OJO CON "registrar un pago" A SECAS: estaba acá, y es exactamente el
      // título de `menu:pago_proveedor`. Quien tocaba esa opción del catálogo
      // terminaba registrando un COBRO — la plata al revés: un recibo contra un
      // cliente que no pagó, en vez de asentar lo que YO le pagué al proveedor.
      // Un sinónimo que no dice de qué lado del mostrador está la plata no
      // puede vivir en ninguna de las dos opciones.
      "me pagaron", "registrar un cobro", "registrar un pago de un cliente", "cobre una factura",
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
      // "mis compras" es el TÍTULO de esta opción, y estaba faltando: quien
      // copiaba el renglón del catálogo tal cual caía en "no entendí". El
      // título es lo único que el usuario ve escrito por nosotros, así que es
      // la frase que MÁS probablemente vuelva textual.
      "mis compras", "cuanto compre", "mis proveedores", "compras del mes", "cuanto le compre",
      "gastos con proveedores", "compras a proveedores", "que compre",
      // LA PLATA PARA EL OTRO LADO. "cuanto le debo a los proveedores" caía en
      // `menu:cobranzas` —"¿quién me debe?"— porque "debo" se parece a "deben"
      // por distancia de edición. Es la misma familia que "registrar un pago":
      // una consulta de plata contestada al revés, que acá se lee como si
      // tuviera plata a cobrar cuando en realidad la tiene que pagar. Van
      // largas para ganarle por inclusión al parecido de una sola palabra.
      "cuanto le debo a los proveedores", "cuanto le debo al proveedor",
      "que le debo a los proveedores", "cuanto debo a proveedores",
      "lo que le debo al mayorista", "cuanto le debo al mayorista",
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
      "registrar un pago", "le pague a un proveedor", "registrar un pago a proveedor",
      "pague una factura de compra", "pagar a proveedor", "asentar un pago",
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
export const SALUDOS = [
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
export const AFIRMACIONES = [
  "si", "si dale", "dale si", "confirmo", "correcto", "exacto", "asi es",
  "mandala", "mandalo", "asi esta bien", "esta bien",
  "ok emitila", "dale emitila", "si por favor", "afirmativo", "sip", "sisi", "obvio",
  "adelante", "procede", "hacelo",
];

/**
 * Afirmaciones que SOLO valen como "sí" si hay un flujo abierto.
 *
 * "emitila" está en dos lugares a la vez, y con razón: en medio de una emisión
 * confirma el preview, y en frío quiere decir "emitime una". Cuando estaban
 * todas juntas en `AFIRMACIONES` ganaba siempre el "sí" —el enrutador las mira
 * antes que a los sinónimos—, así que el almacenero que arrancaba escribiendo
 * "emitila" recibía un acuse de recibo de una pregunta que nadie le había
 * hecho, y ahí se terminaba la conversación.
 *
 * Separadas, en frío caen donde tienen que caer: son sinónimos de
 * `menu:emitir`. Lo encontró el simulador probando los 382 sinónimos del
 * catálogo, no los tres primeros de cada opción.
 */
export const AFIRMACIONES_EN_FLUJO = ["emitila", "emitilo", "emiti"];

/**
 * "Pará, no lo emitas". Cancelaciones escritas.
 *
 * Peor que la falta de "sí": el usuario cree que canceló y el sistema le
 * contesta el menú. Si el paso pendiente era la confirmación de una emisión, la
 * diferencia entre entender esto y no entenderlo es un CFE ante DGI.
 */
export const CANCELACIONES = [
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
export const ASENTIMIENTOS = [
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
export const NEGACIONES_SECAS = ["no", "nop", "no no"];

export const CORTESIAS = [
  "gracias", "muchas gracias", "chau", "saludos",
  "nada mas", "nada", "eso es todo", "ninguna", "no gracias",
];

/**
 * Palabras que no distinguen nada. Se sacan antes de comparar por tokens: son
 * las que hacen que "¿cómo viene el mes?" y "¿cómo dieron el mes?" parezcan
 * distintas cuando son la misma pregunta.
 */
export const VACIAS = new Set([
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
