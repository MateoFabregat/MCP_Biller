# Las variables que dependen del contexto

> Inventario completo de **todo valor que cambia** según la empresa, la fecha, la
> moneda, el ambiente o el caso. Escrito el 03/09/2026 a partir de una auditoría
> que leyó los 120 archivos de `src/`.
>
> **Por qué existe este documento.** Un sistema de facturación no falla por
> algoritmos: falla porque un número que debía cambiar quedó escrito en el
> código, o porque un número que alguien configuró mal pasó sin que nadie
> avisara. Las dos preguntas que ordenan cada tabla son siempre las mismas:
> **¿está en un solo lugar con su motivo al lado?** y **¿el sistema se da cuenta
> cuando está mal?**
>
> La columna que más importa es la última. Un valor equivocado que se detecta
> cuesta una pregunta; uno que pasa callado cuesta un documento fiscal.

---

## 1. Fiscal — lo que cambia por empresa y por fecha

| Variable | Dónde vive | Quién la cambia | Si está mal | ¿Se detecta? |
|---|---|---|---|---|
| **Valor de la UI** (`BILLER_VALOR_UI`) | `config.ts` → `biller/requisitos.ts` | El operador | El umbral de las 5.000 UI se corre: un e-Ticket que exigía receptor sale sin él | **Parcial.** Ausente: sí, avisa siempre. Basura: cae al de referencia **en silencio**. **Vencido: no** |
| **Fecha del valor UI** | `config.ts` | El operador | Nada la usa salvo imprimirla | **No.** Ni el formato ni la antigüedad |
| Valor de referencia de la UI | `biller/requisitos.ts` | Solo el código | El aviso sale de más (nunca de menos: está sesgado a la baja **a propósito**) | N/A, es el fallback |
| Umbral de receptor (5.000 UI) | `biller/requisitos.ts` + env | DGI | Receptor exigido de más o de menos | Basura → silencio |
| **Tasas de IVA** (22 / 10 / exento) | `services/calcularTotales.ts` | DGI | El preview y el tope mienten; el CFE lo calcula Biller | La divergencia con Biller **no se detecta** |
| Default de tasa (básica) | Repartido, defendido con comentario | El código | Se factura al 22% algo exento | El flujo lo pregunta |
| `montos_brutos` ausente = precios netos | `services/calcularTotales.ts` | La API de Biller | El total sale 22% más alto | **Sí**, se declara en cada preview |
| Estados DGI que suman | `services/estadoDgi.ts` | Biller | Un estado nuevo no suma | **Sí**: "N excluidos por estado" en cada total |
| Tipos de comprobante y su categoría | **Cinco tablas en tres archivos** | DGI | Un tipo nuevo no suma, o suma con el signo al revés | Parcial |
| Monedas y sus alias | **Cuatro definiciones distintas** | El código | Una NC en `858` no ata la cotización | No |
| Tasa de cambio | Del comprobante, nunca estimada | Biller | — | **Sí**: cobertura y warnings |
| Redondeo a dos decimales | `biller/coerce.ts` (+ una copia sin epsilon) | El código | Centavos de diferencia con Biller | No |
| **Topes de monto** por moneda | `write/limiteMonto.ts`, por empresa | El operador | Sin tope | Ausencia sí; **basura en silencio** |
| Zona horaria (Montevideo) | `services/fechaUy.ts` | El código | Un CFE con fecha de mañana después de las 21:00 | Tests |
| Sucursal por defecto | Por empresa | El operador | Un id no numérico se ignora **sin avisar** y Biller responde 422 | No |

**Lo peor de esta tabla, y lo que se está arreglando:** el valor de la UI puede
estar vencido o ser un tipeo y nadie lo dice; y las tasas de IVA viven en dos
lugares, así que cambiar una deja la nota de crédito acreditando con la vieja.

---

## 2. Ambiente, credenciales y versiones

| Variable | Dónde | Si está mal | ¿Se detecta? |
|---|---|---|---|
| **test vs. producción** | Derivado de la URL de la API | Nada: cualquier host que no sea `test.` se trata como producción, con el gate estricto | **Sí**, y el arranque falla si la URL no es uno de los dos hosts |
| Hosts de Biller y de Kapso | `config.ts`, allowlist cerrada | El token saldría hacia otro host | **Sí**, el arranque falla |
| **Versión de la Graph API de Meta** | Escrita adentro de un template string | Meta deprecó la versión → todo envío falla, WhatsApp mudo | Sí, ruidoso, pero exige un release |
| **Versión del server** | `constants.ts` **divergente** de `package.json` | Se anuncia una versión que no es la publicada | **No** |
| Versión del protocolo MCP | Del SDK, con caret flotante | Un bump del SDK puede cambiar el dialecto de los schemas | Tests de dialecto |
| Versiones de la API de Biller | `constants.ts`, un solo lugar | 404 | Sí, ruidoso |
| Prefijo de las claves de Kapso (`kapso:v1:`) | `kapso/idempotency.ts` | Cambiar el material sin subir la versión deja reservas viejas irreconocibles | No. **Es el único journal versionado** |
| Versión de la política de aprobación | `write/confirm.ts` | Un cambio de política no invalida tokens previos | No |

---

## 3. Tiempos, techos y límites de canal

| Variable | Valor | Si está mal |
|---|---|---|
| Timeout contra Biller | 30 s (1–120 configurable, **validación estricta**) | Rangos largos se cortan |
| Timeouts de Kapso | 15 s / 60 s | — |
| Rate limit | 30 rps normal, 1 rps DGI, por empresa | 429 de Biller |
| Reintentos de GET | 2, con backoff | Un 429 **no se reintenta hoy** |
| Tope de respuesta | 2 MB Biller, 1 MB Kapso | Una ventana grande tumba la consulta entera sin achicarla |
| Ventana de consulta | 7 días, margen de carga 5 días | Un comprobante cargado tarde queda afuera del total |
| Cache de ventanas | 120 s vivas / 30 min cerradas | Un total con estado viejo |
| **Borradores** | 24 h, 500 sesiones | Un borrador viejo se emite con fecha vieja |
| Sesiones HTTP | 30 min, 200 | Fuga de memoria o handshake de más |
| Replay del webhook | 24 h, 10.000 | Reprocesar un mensaje = contestar dos veces |
| Token de confirmación | 15 min | — |
| Idempotencia de salidas | 15 min (+ tramo anterior) o el día uruguayo | Muda si es larga, duplicada si es corta |
| Compactación del journal | 1.000 líneas | Arranque lento |
| **Límites de WhatsApp** | 4096 texto · 1024 cuerpo · 3 botones · 10 filas · 24 chars por fila | Meta rechaza con un 400 genérico |
| Preview | Presupuesto calculado contra el envoltorio real | Se corta el "¿Lo emito?" |

---

## 4. Las cinco reglas que se desprenden

1. **Un número que decide plata va en un solo lugar, con su motivo al lado.** Las
   tasas de IVA duplicadas y los cuatro sets de alias de moneda son la excepción
   que este documento existe para cerrar.
2. **Un valor configurado mal tiene que hacer ruido.** Hoy hay dos políticas
   conviviendo: el timeout es estricto y hace fallar el arranque; el valor de la
   UI es tolerante y cae a un default en silencio. La asimetría tiene un motivo
   (no romper el arranque de una empresa por un número secundario), pero
   "tolerante" no puede significar "callado".
3. **Los defaults se declaran, no se asumen.** Es la regla que ya cumple el
   preview: cada supuesto que el sistema tomó por su cuenta aparece escrito en el
   mensaje que la persona aprueba.
4. **Lo que varía por empresa nunca se hereda.** El registro tiene una lista
   explícita de variables que no se heredan del proceso, y entra en ella todo lo
   que gobierna una barrera.
5. **Un valor que no se puede saber se dice, no se inventa.** Si falta la tasa de
   cambio, el equivalente en pesos es `null` y se declara la cobertura. Nunca un
   número aproximado sin marca.
