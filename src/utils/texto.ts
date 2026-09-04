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
