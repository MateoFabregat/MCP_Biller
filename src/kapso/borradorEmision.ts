// =============================================================================
// El borrador de emisión: qué ENTRA al estado y qué SALE hacia el CFE.
//
// POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO ES `emision.ts`
//
// `emision.ts` contesta una sola pregunta —"dado lo que ya se sabe, ¿qué
// sigue?"— y la contesta PURA: los dos datos del mundo que necesita entran por
// parámetro, y por eso el test de los 64 estados parciales significa algo. Este
// módulo contesta las otras dos, que son de otra familia:
//
//   · Cómo se LLENA el borrador. Los importes que escribió una persona
//     ("6.500"), el dato que llega sin decir a qué ítem pertenece (el botón de
//     cantidad), y lo que el extractor sacó del texto y hay que volcar sin
//     pisar nada de lo explícito (la jerarquía de la regla 4 del handbook).
//   · Qué CUERPO produce. El payload parcial con la forma exacta que espera
//     `biller_emitir_comprobante`, incluida la decisión —fiscal— de qué campos
//     NO pueden volver por el canal del modelo.
//
// Las dos son decisiones sobre QUÉ VA EN EL COMPROBANTE, o sea reglas fiscales,
// y estaban adentro de `tools/emisionGuiada.ts`. Ahí eran INALCANZABLES desde
// cualquier otra superficie: el día que la emisión entre por el webhook, por un
// cierre de mes o por una segunda tool, había que reimplementarlas —o importar
// una tool desde otra tool, que es el error tabulado del handbook—. Es el mismo
// caso de `correrCuentaCorriente` antes de mudarse a `services/`.
//
// Y NO SE FUSIONÓ CON `emision.ts` por una razón de dependencias, no de tamaño:
// `rellenarDesdePedido` necesita `PedidoEmision`, o sea `extraerPedido.ts`.
// Metiéndolo ahí, la máquina de pasos —que hoy no depende de nada que adivine—
// pasaría a depender de la gramática que adivina. `kapso/` tiene una sola
// dirección de dependencias y conviene que siga teniéndola: este archivo
// importa `emision.ts` y `extraerPedido.ts`, y ninguno de los dos lo importa a
// él (ver ARQUITECTURA §2.1).
//
// LO QUE ESTE MÓDULO NO HACE: no toca la red, no lee la config y no arma un
// solo mensaje de WhatsApp. Todo lo de acá se puede testear con un objeto.
// =============================================================================

import {
  clasificarDocumento,
  type EstadoEmision,
  type ItemEnCurso,
} from "./emision.js";
import { esPedidoDeEmision, type PedidoEmision } from "./extraerPedido.js";
import { formatearUy, parsearCantidad, parsearImporte } from "../services/importe.js";

/**
 * Aplica un dato al ítem que se está cargando (el último del array).
 *
 * Existe porque los botones de un paso de ítem —la cantidad, por ahora— llegan
 * sin decir a QUÉ ítem pertenecen: el id de un botón de WhatsApp no lleva
 * índice. La convención es la misma que usa `siguientePaso`: el ítem en curso
 * es siempre el último. Si no hay ninguno, se crea.
 */
export function aplicarAlItemEnCurso(
  estado: EstadoEmision,
  aplicar: (item: ItemEnCurso) => void,
): void {
  const items = [...(estado.items ?? [])];
  const ultimo = items.length === 0 ? undefined : { ...items[items.length - 1]! };
  const item = ultimo ?? {};
  aplicar(item);
  if (ultimo === undefined) items.push(item);
  else items[items.length - 1] = item;
  estado.items = items;
}

/**
 * Los ítems tal como pueden llegar de afuera: los importes, todavía en texto.
 *
 * `precio` y `cantidad` aceptan string además de número a propósito, y el
 * porqué está escrito en el schema de la tool: si el tipo fuera solo `number`,
 * el que convierte "6.500" en un número es el modelo, y `Number("6.500")` es
 * 6,5. Este es el tipo del otro lado de esa decisión.
 */
export interface ItemCrudo {
  concepto?: string;
  cantidad?: number | string;
  precio?: number | string;
  indicador_facturacion?: number;
}

/**
 * Convierte los `precio`/`cantidad` que llegaron como texto a números.
 *
 * Un ítem cuyo precio no se puede leer queda SIN precio, no con un precio
 * inventado: el flujo vuelve a preguntarlo, que es exactamente lo que hay que
 * hacer. Devolver 0, o `NaN`, o el número más parecido, sería tapar el problema
 * en el único lugar donde todavía se puede resolver preguntando.
 */
export function normalizarItems(items: ReadonlyArray<ItemCrudo> | undefined): {
  items: ItemEnCurso[] | undefined;
  warnings: string[];
} {
  if (items === undefined) return { items: undefined, warnings: [] };
  const warnings: string[] = [];

  const out = items.map((item, i) => {
    const ordinal = items.length === 1 ? "" : ` (ítem ${i + 1})`;
    const salida: ItemEnCurso = {
      ...(item.concepto !== undefined ? { concepto: item.concepto } : {}),
      ...(item.indicador_facturacion !== undefined
        ? { indicador_facturacion: item.indicador_facturacion }
        : {}),
    };

    // El flag va SIEMPRE que se fije un precio, incluso en false, y por el
    // mismo motivo por el que `montos_brutos` va siempre al borrador: el
    // guardado se fusiona por campo y `undefined` no pisa (ver `fusionarEstado`).
    // Sin el false explícito, un precio corregido a mano ("son 6500") dejaría
    // viva para siempre la advertencia del "6.50" anterior.
    if (typeof item.precio === "number") {
      salida.precio = item.precio;
      salida.precio_ambiguo = false;
    } else if (typeof item.precio === "string") {
      const leido = parsearImporte(item.precio);
      if (leido.valor === null) {
        warnings.push(`No se pudo leer el precio "${item.precio}"${ordinal}: ${leido.detalle}`);
      } else {
        salida.precio = leido.valor;
        // La marca se GUARDA además de avisarse: un warning lo lee el modelo en
        // esta llamada y se pierde, y la confirmación ocurre dos o tres mensajes
        // después. Ver `ItemEnCurso.precio_ambiguo`.
        salida.precio_ambiguo = leido.ambiguo;
        if (leido.ambiguo) {
          warnings.push(
            `⚠️ El precio "${item.precio}"${ordinal} se puede leer de dos formas. ${leido.detalle} ` +
              `Preguntale al usuario "¿$${formatearUy(leido.valor)} por unidad?" y esperá que lo ` +
              "confirme ANTES de emitir.",
          );
        }
      }
    }

    if (typeof item.cantidad === "number") {
      salida.cantidad = item.cantidad;
    } else if (typeof item.cantidad === "string") {
      const leida = parsearCantidad(item.cantidad);
      if (leida.valor === null) {
        warnings.push(`No se pudo leer la cantidad "${item.cantidad}"${ordinal}: ${leida.detalle}`);
      } else {
        salida.cantidad = leida.valor;
      }
    }

    return salida;
  });

  return { items: out, warnings };
}

/**
 * Vuelca lo que el extractor leyó del texto SOBRE LOS HUECOS del estado.
 *
 * LA REGLA, Y NO TIENE EXCEPCIONES: un campo que ya tiene valor no se toca.
 * Lo que mandó el agente es un dato explícito de la conversación; lo de acá es
 * una inferencia gramatical sobre el mismo texto. Cuando los dos dicen algo,
 * gana el explícito — y cuando el explícito falta, esto es la diferencia entre
 * una pregunta menos y una pregunta más.
 *
 * DOS NIVELES DE CONFIANZA, Y POR ESO DOS TRATOS DISTINTOS:
 *
 *   · Las SEÑALES (forma de pago, criterio de IVA) salen de marcas inequívocas
 *     —"a crédito", "más IVA"— y valen aunque el mensaje no sea un pedido
 *     entero: "sin IVA" contestando una pregunta del flujo es exactamente eso.
 *   · El CLIENTE y los ÍTEMS salen de una gramática posicional, y solo se
 *     aplican cuando el mensaje ES un pedido (`esPedidoDeEmision`). Sin ese
 *     filtro, "pará, eran 3 no 2" en medio de una carga dejaba un cliente
 *     llamado "eran" en el borrador de un CFE.
 *
 * LA MONEDA NO SE FIJA ACÁ, A PROPÓSITO. El extractor la lee ("en dólares") y
 * esta función la convierte en `moneda_dudosa`, o sea en una PREGUNTA. Es el
 * único campo donde equivocarse cuesta 40x —una factura en pesos por un precio
 * cotizado en dólares sale perfectamente bien formada ante DGI— y un toque de
 * más es barato al lado de eso. Ver `moneda_dudosa` en `emision.ts`.
 */
export function rellenarDesdePedido(estado: EstadoEmision, pedido: PedidoEmision): string[] {
  const puestos: string[] = [];

  if (estado.montos_brutos === undefined && pedido.montos_brutos !== undefined) {
    estado.montos_brutos = pedido.montos_brutos;
    puestos.push("montos_brutos");
  }
  if (estado.forma_pago === undefined && pedido.forma_pago !== undefined) {
    estado.forma_pago = pedido.forma_pago;
    puestos.push("forma_pago");
  }
  if (pedido.moneda === "USD" && (estado.moneda ?? "") === "") {
    estado.moneda_dudosa = true;
  }

  if (!esPedidoDeEmision(pedido)) return puestos;

  // El NOMBRE, no el documento: quién es ese nombre lo contesta
  // `biller_resolver_nombre`, que sabe preguntar cuando hay dos candidatos.
  if (
    pedido.cliente !== undefined &&
    (estado.nombre_cliente ?? "") === "" &&
    (estado.documento ?? "") === ""
  ) {
    estado.nombre_cliente = pedido.cliente;
    puestos.push("nombre_cliente");
  }

  if (pedido.items.length === 0) return puestos;
  const items: ItemEnCurso[] = [...(estado.items ?? [])];
  pedido.items.forEach((leido, i) => {
    const base: ItemEnCurso = { ...(items[i] ?? {}) };
    if ((base.concepto ?? "") === "" && leido.concepto !== undefined) {
      base.concepto = leido.concepto;
      puestos.push(`items[${i}].concepto`);
    }
    if (base.cantidad === undefined && leido.cantidad !== undefined) {
      base.cantidad = leido.cantidad;
      puestos.push(`items[${i}].cantidad`);
    }
    if (base.precio === undefined && leido.precio !== undefined) {
      base.precio = leido.precio;
      // La marca viaja PEGADA al precio, en la misma condición: sin esto, el
      // "6.50" entraba al estado como 6,5 pelado y el preview mostraba $13 sin
      // una palabra sobre las otras dos lecturas posibles. Ver `precio_ambiguo`.
      base.precio_ambiguo = leido.precio_ambiguo === true;
      puestos.push(`items[${i}].precio`);
    }
    items[i] = base;
  });

  // NÚMEROS QUE SOBRARON = VENTA QUE NO SE PUDO LEER.
  //
  // "…3 cajas a 1200 y portland a 6500": el segundo tramo no trae cantidad, así
  // que no hay ítem donde poner los $6.500. Antes se descartaban en silencio y
  // el flujo llegaba a `listo` con media factura. Abrir un ítem vacío es la
  // forma que ya tiene este flujo de decir "seguí preguntando por otro"
  // (`siguientePaso` mira siempre el último), y convierte la pérdida silenciosa
  // en la pregunta que corresponde.
  if (pedido.precios_sin_ubicar.length > 0) {
    const ultimo = items[items.length - 1];
    if (ultimo === undefined || Object.keys(ultimo).length > 0) {
      items.push({});
      puestos.push(`items[${items.length - 1}] (abierto por un precio sin ubicar)`);
    }
    delete estado.items_cerrados;
  }

  if (items.length > 0) estado.items = items;
  return puestos;
}

/**
 * Arma el borrador con la forma que espera `biller_emitir_comprobante`.
 *
 * DELIBERADAMENTE NO INCLUYE `concepto` NI `razon_social`, y no es un descuido:
 *
 * Esos dos nombres de clave están en `CAMPOS_NO_CONFIABLES`, así que la barrera
 * de salida los envuelve en ⟦dato-no-confiable⟧ antes de que salgan del server.
 * Para el texto de un comprobante RECIBIDO eso es exactamente lo correcto. Pero
 * un borrador que vuelve envuelto es peor que inútil: si el agente lo pasa tal
 * cual a la emisión, las marcas terminan impresas en el CFE.
 *
 * La salida no es debilitar la barrera —compara por nombre de clave a propósito,
 * y una excepción acá es la grieta por la que después pasa texto de un tercero—.
 * Es notar que esos dos campos no tienen por qué estar acá: el borrador existe
 * para cargar lo que la tool DEDUJO (el tipo de CFE, el indicador de IVA, la
 * forma de pago), que es justo donde un modelo se equivoca caro. El concepto y
 * la razón social los escribió el usuario hace dos mensajes y el agente los
 * tiene textuales; copiarlos es lo único que sabe hacer sin equivocarse.
 *
 * Por eso el borrador viene acompañado de `completar`: qué falta agregarle y de
 * dónde sacarlo. Ver `menuWhatsapp.ts` para el mismo problema resuelto al revés
 * (ahí se pudo renombrar la clave; acá la clave es parte del contrato de la API).
 */
export function borradorComprobante(
  estado: EstadoEmision,
  tipo: number | null,
): { borrador: Record<string, unknown>; completar: string[] } {
  const borrador: Record<string, unknown> = {};
  const completar: string[] = [];

  if (tipo !== null) borrador["tipo_comprobante"] = tipo;
  // `numero_interno` NO VUELVE ACÁ, y esa es toda la defensa contra el duplicado.
  //
  // Está en CAMPOS_NO_CONFIABLES, así que la barrera de salida lo envuelve en
  // ⟦dato-no-confiable⟧ antes de que salga del server. Un id envuelto le deja
  // al modelo dos caminos y los dos terminan mal: copiarlo con las marcas
  // adentro (y emitir un CFE con basura en el campo), o limpiarlo a mano — que
  // es peor, porque dos reintentos que limpian distinto producen DOS ids
  // distintos, `buscarPorNumeroInterno` no matchea ninguno, y la misma venta
  // sale dos veces ante DGI. Justo lo que este id existe para impedir.
  //
  // El id se genera en el server, vive en el store y lo completa
  // `completarDesdeSesion` al emitir: nunca pasa por el canal del modelo. Por
  // eso tampoco hace falta declararlo en `completar` — no hay nada que copiar.
  if (estado.fecha_emision !== undefined) borrador["fecha_emision"] = estado.fecha_emision;
  if (estado.forma_pago !== undefined) borrador["forma_pago"] = estado.forma_pago;
  if (estado.moneda !== undefined) borrador["moneda"] = estado.moneda;
  if (estado.tasa_cambio !== undefined) borrador["tasa_cambio"] = estado.tasa_cambio;
  if (estado.fecha_vencimiento !== undefined) {
    borrador["fecha_vencimiento"] = estado.fecha_vencimiento;
  }
  // `montos_brutos` va SIEMPRE que se sepa, incluso en false.
  //
  // Omitirlo no es neutral: la API interpreta la ausencia como "los precios son
  // netos" y le suma el IVA. O sea que el silencio ya es una respuesta, y es la
  // equivocada para el precio de mostrador uruguayo, que se cotiza con IVA
  // adentro. Un borrador que no lleva el campo factura 22% de más.
  if (estado.montos_brutos !== undefined) borrador["montos_brutos"] = estado.montos_brutos;

  if (estado.documento !== undefined) {
    const d = clasificarDocumento(estado.documento);
    if (d.tipo !== "desconocido") {
      // `tipo_documento` YA está deducido (12 dígitos = RUT, 7-8 = CI): dejarlo
      // afuera obligaba al modelo a re-deducirlo, y ese código decide en qué
      // CAMPO va el nombre del cliente. Ver el `completar` de acá abajo.
      const cliente: Record<string, unknown> = {
        tipo_documento: d.tipo === "rut" ? 2 : 3,
        documento: d.normalizado,
      };

      // `cliente.sucursal.pais` es obligatorio para clientes que no son
      // empresas, así que va SIEMPRE y no solo cuando el cliente es nuevo.
      const sucursal: Record<string, unknown> = { pais: "UY" };
      if (estado.cliente_ya_facturado === false) {
        // Dirección y ciudad solo cuando hay que darlo de alta: son los dos
        // campos que la API exige en esa llamada (verificado: 422 sin ellos).
        if (estado.direccion_cliente !== undefined) sucursal["direccion"] = estado.direccion_cliente;
        if (estado.ciudad_cliente !== undefined) sucursal["ciudad"] = estado.ciudad_cliente;
      }
      cliente["sucursal"] = sucursal;
      borrador["cliente"] = cliente;
    }
  }
  if (estado.nombre_cliente !== undefined && estado.nombre_cliente.trim() !== "") {
    // EL CAMPO DEPENDE DEL TIPO DE DOCUMENTO, y no es intercambiable: con RUT
    // el nombre principal es `razon_social`; con cédula es `nombre_fantasia`.
    // Antes esto decía siempre "razon_social", así que a un consumidor final
    // identificado con CI se le mandaba el nombre en el campo equivocado.
    const d = estado.documento === undefined ? null : clasificarDocumento(estado.documento);
    const campo = d?.tipo === "ci" ? "cliente.nombre_fantasia" : "cliente.razon_social";
    const porque =
      d?.tipo === "ci"
        ? "es una cédula (tipo_documento 3), y para 3/5/6 el nombre principal va en nombre_fantasia"
        : "es un RUT (tipo_documento 2), y para 2/7 el nombre principal va en razon_social";
    completar.push(
      `${campo}: ponelo vos, con el nombre que te dio el usuario en la conversación — ${porque}. ` +
        "(No lo devuelvo acá para no ensuciarlo con las marcas de la barrera de salida.)",
    );
  }

  const items = (estado.items ?? [])
    // Un ítem a medio cargar no va al borrador: mandar precio sin concepto
    // produce un 422 que habla de un campo que el usuario nunca vio.
    .filter((i) => (i.concepto ?? "") !== "" && typeof i.precio === "number")
    .map((i) => {
      const item: Record<string, unknown> = {};
      if (i.cantidad !== undefined) item["cantidad"] = i.cantidad;
      if (i.precio !== undefined) item["precio"] = i.precio;
      const ind = i.indicador_facturacion ?? estado.indicador_facturacion;
      if (ind !== undefined) item["indicador_facturacion"] = ind;
      return item;
    });
  if (items.length > 0) {
    borrador["items"] = items;
    completar.push(
      "items[].concepto: completá cada ítem con la descripción TEXTUAL que dio el usuario, en el " +
        "mismo orden en que la dijo. Es el único campo del cuerpo que sale de la conversación.",
    );
  }

  // `adenda` está en CAMPOS_NO_CONFIABLES igual que `concepto`: si volviera acá
  // volvería envuelta, y esas marcas terminarían impresas en el CFE.
  if (estado.adenda !== undefined && estado.adenda.trim() !== "") {
    completar.push(
      "adenda: ponela vos, con las palabras textuales del usuario (no la devuelvo acá por la " +
        "barrera de salida).",
    );
  }

  return { borrador, completar };
}
