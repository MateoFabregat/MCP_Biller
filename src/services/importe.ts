// =============================================================================
// Leer un importe escrito por una persona.
//
// EL PROBLEMA, EN UNA LÍNEA
//
// `Number("6.500")` es **6.5**. En Uruguay "6.500" son seis mil quinientos.
//
// Hasta acá el único que convertía "6.500" en un número era el modelo, antes de
// llamar a la tool: `precio` se declara `z.number()` y `coerce.aNumero` hace
// `Number(t)`. Un modelo que se come el punto factura la bolsa de harina a
// $6,50 — y el error no se ve en ningún lado hasta que el CFE está emitido,
// porque 6.5 es un precio perfectamente válido.
//
// Esto NO es un caso raro. Es cómo escribe los precios todo el mundo acá.
//
// LA REGLA
//
// El separador decimal es la coma. El punto es de miles. Eso resuelve el 95% y
// deja un caso genuinamente ambiguo: **un punto solo con exactamente dos
// decimales** ("6.50"), que puede ser 6,50 (formato importado de una planilla) o
// un error de tipeo por 6.500. Ahí no se adivina: se devuelve el valor MÁS
// PROBABLE junto con `ambiguo: true`, y quien llama tiene que repetírselo al
// usuario antes de emitir. Un eco cuesta un mensaje; el otro camino cuesta una
// nota de crédito.
//
// ⚠️ ESTO ES SOLO PARA TEXTO ESCRITO POR UNA PERSONA
//
// La API de Biller devuelve los números como strings en formato SQL, donde el
// punto SÍ es decimal: `"total": "610.00"`, `"precio": "1200.000000"`,
// `"cantidad": "1.000"` (que es uno), `"tasa_cambio": "38.397"`. Para eso está
// `toNumberOrNull` en `biller/normalize.ts`, y está bien como está.
//
// Son dos convenciones opuestas conviviendo en el mismo proceso, y la única
// razón por la que no chocan es que se aplican a cosas distintas: `normalize.ts`
// lee lo que manda la API, este módulo lee lo que escribe el usuario. Unificar
// los dos "para no repetir lógica" convierte todas las cantidades de la API en
// miles, o todos los precios del mostrador en centésimos. No unificar.
//
// POR QUÉ NO SE ACEPTA TODO
//
// "seis mil quinientos" no se parsea a propósito. Un parser de números en letras
// es fácil de escribir y difícil de acotar: "dos cincuenta" son 250 o 2,50 según
// el rubro, y equivocarse ahí es exactamente el error caro. Se devuelve
// `null` con un motivo, y quien llama vuelve a preguntar — que es lo que haría
// una persona.
// =============================================================================

/** El resultado de leer un importe. `valor` null significa "no se pudo". */
export interface ImporteLeido {
  valor: number | null;
  /**
   * true cuando la escritura admite más de una lectura y se eligió la más
   * probable. QUIEN LLAMA TIENE QUE ECOAR EL VALOR antes de usarlo.
   */
  ambiguo: boolean;
  /** Moneda detectada en el texto ("UYU"/"USD"), si el usuario la escribió. */
  moneda: string | null;
  /** true si el usuario dijo explícitamente "más IVA". */
  mas_iva: boolean;
  /** Qué se entendió, o por qué no se pudo. En castellano, para repetírselo. */
  detalle: string;
}

/** Símbolos y palabras que marcan la moneda. El orden importa: U$S antes que $. */
const MARCAS_MONEDA: ReadonlyArray<{ patron: RegExp; moneda: string }> = [
  { patron: /u\$s|us\$|usd|d[oó]lar(es)?/i, moneda: "USD" },
  { patron: /\$u|uyu|pesos?/i, moneda: "UYU" },
  // El "$" pelado va ÚLTIMO: en Uruguay significa pesos, pero "U$S" también lo
  // contiene y se tiene que haber resuelto antes.
  { patron: /\$/, moneda: "UYU" },
];

const MARCA_MAS_IVA = /(\+|m[aá]s)\s*iva|iva\s+aparte|sin\s+iva/i;

/**
 * Lee un importe escrito a mano.
 *
 * Acepta lo que la gente escribe de verdad: "6500", "6.500", "6,500", "$ 6.500",
 * "6500 + iva", "U$S 120,50". Rechaza —con motivo— lo que no puede leer sin
 * adivinar.
 */
export function parsearImporte(raw: string): ImporteLeido {
  const texto = (raw ?? "").trim();
  const base: ImporteLeido = {
    valor: null,
    ambiguo: false,
    moneda: null,
    mas_iva: false,
    detalle: "",
  };
  if (texto === "") {
    return { ...base, detalle: "Llegó vacío: no hay importe que leer." };
  }

  const moneda = MARCAS_MONEDA.find((m) => m.patron.test(texto))?.moneda ?? null;
  const masIva = MARCA_MAS_IVA.test(texto);

  // Se saca todo lo que no sea dígito, punto o coma. Lo que quede tiene que ser
  // UN número: dos números sueltos ("2 x 6500") es una frase, no un importe, y
  // resolverla acá sería adivinar cuál de los dos es el precio.
  const limpio = texto.replace(/[^\d.,]/g, " ").trim();
  const trozos = limpio.split(/\s+/).filter((t) => t !== "" && /\d/.test(t));

  if (trozos.length === 0) {
    return {
      ...base,
      moneda,
      mas_iva: masIva,
      detalle:
        `"${texto}" no tiene ningún número. Si el usuario escribió el importe en letras ` +
        '("seis mil quinientos"), volvé a preguntarlo en números: adivinarlo es el error caro.',
    };
  }
  if (trozos.length > 1) {
    return {
      ...base,
      moneda,
      mas_iva: masIva,
      detalle:
        `"${texto}" tiene ${trozos.length} números (${trozos.join(", ")}) y no se puede saber cuál ` +
        "es el importe. Preguntá cuál es el precio por unidad.",
    };
  }

  const numero = trozos[0]!;
  const leido = interpretarNumero(numero);
  if (leido.valor === null) {
    return { ...base, moneda, mas_iva: masIva, detalle: leido.detalle };
  }

  // El signo se conserva. Al limpiar el texto el "-" se pierde, y devolver 3
  // para "-3" es corregir en silencio el signo de un número — el tipo de ayuda
  // que después nadie encuentra. Si el usuario escribió un negativo, que se vea:
  // quien llama decide si tiene sentido en su contexto (en una cantidad no lo
  // tiene, y `parsearCantidad` lo rechaza).
  const negativo = new RegExp(`-\\s*${escaparRegex(numero)}`).test(texto);
  const valor = negativo ? -leido.valor : leido.valor;

  return {
    valor,
    ambiguo: leido.ambiguo,
    moneda,
    mas_iva: masIva,
    detalle: negativo ? `${leido.detalle} El importe es NEGATIVO.` : leido.detalle,
  };
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** El núcleo: qué significan el punto y la coma en esta cadena. */
function interpretarNumero(n: string): { valor: number | null; ambiguo: boolean; detalle: string } {
  const puntos = (n.match(/\./g) ?? []).length;
  const comas = (n.match(/,/g) ?? []).length;

  // 1. Los dos separadores: el ÚLTIMO que aparece es el decimal. No hay
  //    ambigüedad posible — "1.234,56" y "1,234.56" se distinguen solos.
  if (puntos > 0 && comas > 0) {
    const decimal = n.lastIndexOf(",") > n.lastIndexOf(".") ? "," : ".";
    const miles = decimal === "," ? "." : ",";
    const valor = Number(n.split(miles).join("").replace(decimal, "."));
    return Number.isFinite(valor)
      ? { valor, ambiguo: false, detalle: `Se leyó ${formatearUy(valor)}.` }
      : { valor: null, ambiguo: false, detalle: `No se pudo leer "${n}" como número.` };
  }

  // 2. Solo comas: la coma es decimal salvo que separe grupos de tres.
  if (comas > 0) {
    if (comas === 1 && /^\d{1,3}(,\d{3})$/.test(n)) {
      // "6,500" con formato de miles importado. Es ambiguo de verdad: también
      // puede ser seis coma cinco. Gana miles porque un precio de mostrador con
      // tres decimales no existe.
      const valor = Number(n.replace(",", ""));
      return {
        valor,
        ambiguo: true,
        detalle:
          `"${n}" se leyó como ${formatearUy(valor)} (coma de miles). También podría ser ` +
          `${n.replace(",", ".")}. CONFIRMALO con el usuario antes de emitir.`,
      };
    }
    const valor = Number(n.split(",").join(comas > 1 ? "" : "."));
    return Number.isFinite(valor)
      ? { valor, ambiguo: false, detalle: `Se leyó ${formatearUy(valor)}.` }
      : { valor: null, ambiguo: false, detalle: `No se pudo leer "${n}" como número.` };
  }

  // 3. Solo puntos.
  if (puntos > 0) {
    //    Más de un punto: siempre miles ("1.234.567").
    if (puntos > 1) {
      const valor = Number(n.split(".").join(""));
      return Number.isFinite(valor)
        ? { valor, ambiguo: false, detalle: `Se leyó ${formatearUy(valor)} (puntos de miles).` }
        : { valor: null, ambiguo: false, detalle: `No se pudo leer "${n}" como número.` };
    }
    const decimales = n.length - n.indexOf(".") - 1;
    //    Tres decimales exactos y hasta tres enteros: es miles, sin duda.
    //    "6.500" = seis mil quinientos. Éste es EL caso que motiva el módulo.
    if (decimales === 3 && /^\d{1,3}\.\d{3}$/.test(n)) {
      const valor = Number(n.replace(".", ""));
      return {
        valor,
        ambiguo: false,
        detalle: `"${n}" se leyó como ${formatearUy(valor)}: en Uruguay el punto es de miles.`,
      };
    }
    //    Dos decimales: genuinamente ambiguo. Gana el decimal (es lo que sale de
    //    una planilla o de un sistema), pero se marca para que se confirme.
    if (decimales === 2) {
      const valor = Number(n);
      return {
        valor,
        ambiguo: true,
        detalle:
          `"${n}" se leyó como ${formatearUy(valor)} (punto decimal). Si el usuario quiso decir ` +
          `${formatearUy(Number(n.replace(".", "")))}, esto está mal por cien veces: CONFIRMALO ` +
          "antes de emitir.",
      };
    }
    const valor = Number(n);
    return Number.isFinite(valor)
      ? { valor, ambiguo: false, detalle: `Se leyó ${formatearUy(valor)}.` }
      : { valor: null, ambiguo: false, detalle: `No se pudo leer "${n}" como número.` };
  }

  // 4. Sin separadores: no hay nada que interpretar.
  const valor = Number(n);
  return Number.isFinite(valor)
    ? { valor, ambiguo: false, detalle: `Se leyó ${formatearUy(valor)}.` }
    : { valor: null, ambiguo: false, detalle: `No se pudo leer "${n}" como número.` };
}

/**
 * Formatea a la uruguaya: punto de miles, coma decimal.
 *
 * Se usa en los mensajes de vuelta, y no es cosmética: el eco de confirmación
 * tiene que estar escrito como el usuario escribe los números, o el usuario no
 * puede verificar lo que le estamos preguntando.
 */
export function formatearUy(valor: number): string {
  const [entero, decimal] = Math.abs(valor).toFixed(2).split(".");
  const conMiles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cuerpo = decimal === "00" ? conMiles : `${conMiles},${decimal}`;
  return valor < 0 ? `-${cuerpo}` : cuerpo;
}

/** "$" o "U$S". Se usa en toda pregunta que le muestre plata al usuario. */
export function simboloMoneda(moneda: string | undefined): string {
  const m = (moneda ?? "UYU").toUpperCase();
  if (m === "USD") return "U$S";
  return m === "UYU" ? "$" : `${m} `;
}

/**
 * La plata, escrita como se escribe en Uruguay, con el signo ANTES del símbolo.
 *
 * "$-200" no es como se escribe un importe negativo en ningún lado, y este eco
 * lo lee alguien que está por tocar un botón que TIRA esa línea. La convención
 * ya estaba fijada y testeada en `calcularTotales` (`not.toContain("$-")`);
 * esto es el mismo criterio en un solo lugar, para que no vuelva a divergir.
 * Se usa el menos tipográfico (−) por lo mismo que el resto del flujo: el
 * guión ASCII pegado al símbolo se lee como parte del número.
 */
export function montoConSigno(moneda: string | undefined, valor: number): string {
  const magnitud = `${simboloMoneda(moneda)}${formatearUy(Math.abs(valor))}`;
  return valor < 0 ? `−${magnitud}` : magnitud;
}

/** Lo mismo para cantidades. Separado porque las reglas NO son las mismas. */
export interface CantidadLeida {
  valor: number | null;
  detalle: string;
}

/**
 * Lee una cantidad.
 *
 * A diferencia del importe, acá los números en letras SÍ se aceptan hasta doce:
 * "dos bolsas" es lo que la gente contesta a "¿cuántos?", el rango es chico y
 * cerrado, y ninguno de esos doce valores es ambiguo. Es exactamente lo
 * contrario del caso de los importes, donde el rango es infinito y "dos
 * cincuenta" no tiene una lectura única.
 */
const NUMEROS_EN_LETRAS: Readonly<Record<string, number>> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  media: 0.5, medio: 0.5,
  // "docena" y "par" son cantidades, no adjetivos, y aparecen solas. Sin
  // ellas, "media docena" devolvía 0,5 — media unidad de algo.
  docena: 12, docenas: 12, par: 2, pares: 2,
};

export function parsearCantidad(raw: string): CantidadLeida {
  const texto = (raw ?? "").trim().toLowerCase();
  if (texto === "") return { valor: null, detalle: "Llegó vacía: no hay cantidad que leer." };

  const palabras = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9.,]+/)
    .filter((p) => p !== "");

  // Un negativo no es una cantidad, y va antes que todo lo demás: el split se
  // come el "-", así que hay que mirarlo en el texto original. Devolver 3 para
  // "-3" sería corregir el signo en silencio.
  if (/-\s*\d/.test(texto)) {
    return { valor: null, detalle: `"${raw}" es negativo: una cantidad tiene que ser mayor que cero.` };
  }

  // LOS DÍGITOS GANAN SIEMPRE, Y VAN PRIMERO.
  //
  // Al revés —que es como estaba— cualquier "un"/"una" perdido en la frase le
  // ganaba al número escrito con dígitos, porque el bucle recorría TODAS las
  // palabras buscando la tabla de letras:
  //
  //   "12 cajas de una unidad"  ->  1
  //   "2 bolsas de un kilo"     ->  1
  //
  // O sea: facturar una caja en vez de doce, sin que se vea en ningún lado
  // hasta que el CFE está emitido. Es exactamente el modo de falla que este
  // módulo existe para cerrar, reproducido adentro del módulo.
  const conDigitos = palabras.filter((p) => /\d/.test(p));
  if (conDigitos.length > 0) {
    const leido = parsearImporte(conDigitos[0]!);
    if (leido.valor !== null) {
      if (leido.valor <= 0) {
        return {
          valor: null,
          detalle: `La cantidad tiene que ser mayor que cero (llegó ${leido.valor}).`,
        };
      }
      return { valor: leido.valor, detalle: leido.detalle };
    }
  }

  // Números en letras: SOLO las dos primeras palabras, y solo si no había
  // dígitos. "dos" contestando "¿cuántos?" es la respuesta entera; "una" en el
  // medio de una frase es un artículo, no una cantidad.
  //
  // Se miran DOS y no una por las cantidades compuestas: en "una docena" y "un
  // par", la primera palabra es el artículo y el número está en la segunda.
  const primera = palabras[0];
  const segunda = palabras[1];
  if (primera !== undefined) {
    const v1 = NUMEROS_EN_LETRAS[primera];
    const v2 = segunda === undefined ? undefined : NUMEROS_EN_LETRAS[segunda];
    if (v1 !== undefined && v1 <= 1 && v2 !== undefined && v2 > 1) {
      // "media docena" son SEIS, no doce: el primero multiplica al segundo.
      // Con "una docena" el multiplicador es 1 y da lo mismo, que es lo correcto.
      const valor = v1 * v2;
      return { valor, detalle: `"${primera} ${segunda}" se leyó como ${valor}.` };
    }
    if (v1 !== undefined) {
      return { valor: v1, detalle: `"${primera}" se leyó como ${v1}.` };
    }
  }

  return {
    valor: null,
    detalle:
      `No se pudo leer una cantidad en "${raw}". Volvé a preguntar "¿cuántos?" y esperá un número: ` +
      "inventarla es el error que no se ve hasta que la factura está emitida.",
  };
}
