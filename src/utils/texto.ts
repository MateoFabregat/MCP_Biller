// =============================================================================
// Recorte de texto que no rompe lo que recorta.
//
// `String.prototype.slice` cuenta UTF-16 code units, no caracteres. Un emoji
// —y varios de los que este server manda: 🩸 ✅ 📅— ocupa DOS code units, así
// que cortar en el límite puede dejar la primera mitad de un par suplente
// suelta. El resultado es un string inválido: `"…\ud83d"`.
//
// Eso importa porque el destino es la Cloud API de WhatsApp. Un body con un
// surrogate suelto no es JSON válido en el sentido estricto —`JSON.stringify`
// lo serializa igual, pero el receptor puede rechazarlo— y el modo de falla es
// el peor de este proyecto: el mensaje no sale y nadie se entera.
//
// Se corta por PUNTOS DE CÓDIGO y se retrocede si el último quedó partido.
// No resuelve clusters de grafemas (una bandera o un emoji con modificador de
// tono pueden partirse en dos glifos válidos), pero eso degrada la vista sin
// romper el mensaje, que es la línea que sí importa acá.
// =============================================================================

/** true si el code unit en `i` es la primera mitad de un par suplente. */
function esSurrogateAlto(texto: string, i: number): boolean {
  const c = texto.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * Recorta `texto` a `max` code units sin dejar un surrogate suelto al final.
 *
 * `sufijo` (por defecto vacío) se agrega solo si hubo recorte, y su largo se
 * descuenta del tope: el resultado nunca supera `max`.
 */
export function recortarSeguro(texto: string, max: number, sufijo = ""): string {
  if (max <= 0) return "";
  if (texto.length <= max) return texto;

  let corte = Math.max(0, max - sufijo.length);
  // Si el corte cae justo después de un surrogate alto, ese carácter quedó
  // partido: se retrocede uno.
  if (corte > 0 && esSurrogateAlto(texto, corte - 1)) corte -= 1;

  return `${texto.slice(0, corte)}${sufijo}`;
}

/**
 * Deja un texto de tercero listo para ser el TÍTULO de una fila o un botón.
 *
 * El nombre de un cliente lo escribió alguien más —el usuario, o DGI— y acá va
 * a un lugar donde no puede llevar marcas de la barrera de salida: un título
 * con `⟦dato-no-confiable⟧` adentro es un botón ilegible. Entonces, en vez de
 * marcarlo, se lo deja incapaz de hacer daño:
 *
 *  · se neutralizan los delimitadores de la envoltura, para que nadie pueda
 *    "cerrarla" desde adentro de su propia razón social;
 *  · se sacan los caracteres de control, que no se ven y rompen el JSON del
 *    payload de WhatsApp;
 *  · se colapsan los espacios, porque un título con saltos de línea rompe la
 *    fila.
 *
 * El recorte a los caracteres que WhatsApp permite lo hace `recortarSeguro`,
 * que es lo que sabe no partir un emoji al medio.
 */
export function limpiarParaTitulo(texto: string): string {
  return texto
    .split("⟦/dato-no-confiable⟧")
    .join("")
    .split("⟦dato-no-confiable⟧")
    .join("")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
