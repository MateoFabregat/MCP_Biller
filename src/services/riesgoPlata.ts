// =============================================================================
// Plata en riesgo: las alertas que hablan de dinero, no de trámite.
//
// POR QUÉ EXISTE ESTE MÓDULO SEPARADO DE `alertas.ts`.
// `alertas.ts` mira CUMPLIMIENTO: rechazos de DGI, CAE por agotarse, carga
// fuera de plazo. Son correctas y le importan al contador. Este módulo mira
// otra cosa: qué me cuesta dinero si no lo miro hoy. Un CAE vencido para la
// facturación; un cliente que se está yendo se lleva la facturación sin que
// nada se rompa. La segunda duele más y no avisa.
//
// TRES REGLAS DE DISEÑO, sacadas de por qué la primera tanda de alertas no
// servía:
//
//  1. UMBRAL RELATIVO AL PROPIO NEGOCIO. "Facturaste menos de $100.000" no
//     significa nada — depende del negocio. "Facturaste 40% menos que TU
//     promedio" sí. Todos los umbrales de acá son relativos a la historia del
//     mismo cliente o de la misma empresa.
//
//  2. UNA ACCIÓN, NO UN DIAGNÓSTICO. "Concentración alta" no es una alerta.
//     "El 62% viene de un cliente que además está 45 días atrasado: conviene
//     revisar el acuerdo" sí lo es. Cada alerta trae el campo `accion`.
//
//  3. SILENCIO CUANDO NO HAY NADA. Sin hallazgos, la lista viene vacía. Un
//     aviso que llega todos los días se deja de leer, y el día que importa
//     tampoco se lee.
//
// ESTE MÓDULO NO CONSULTA NADA. Recibe los resultados ya calculados por
// `rankingClientes`, `cuentaCorriente` y `compararPeriodos`, y los cruza. Es
// una función pura: se testea sin red, y el costo en llamadas a la API lo paga
// la tool, una sola vez, compartiendo la misma consulta entre todos los cruces.
//
// EL CAVEAT DE COBRANZA VIAJA SIEMPRE. Todo lo que dependa de la cuenta
// corriente hereda su `estrategia`: si la imputación fue FIFO, el saldo POR
// FACTURA es una estimación y la alerta lo dice.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import type { CuentaCorrienteResultado, SaldoCliente } from "./cuentaCorriente.js";
import type { ComparacionResultado } from "./comparacion.js";
import type { ClienteRanking, RankingClientesResultado } from "./rankingClientes.js";
import type { Severidad } from "./alertas.js";

const ORDEN_SEVERIDAD: Record<Severidad, number> = { critica: 0, advertencia: 1, info: 2 };

// --- Umbrales ---------------------------------------------------------------
// Todos relativos. Cambiarlos cambia el producto, así que están acá, con nombre
// y con el motivo escrito.

/** Caída mínima contra el propio promedio del cliente para avisar. */
export const CAIDA_CLIENTE_PCT = 40;
/** Cuántos clientes del top se vigilan por fuga. Más abajo el ruido supera la señal. */
export const TOP_CLIENTES_VIGILADOS = 10;
/** Días de atraso a partir de los cuales un cliente grande pasa a ser exposición. */
export const ATRASO_RELEVANTE_DIAS = 30;
/** Atraso que convierte esa exposición en crítica. */
export const ATRASO_CRITICO_DIAS = 60;
/**
 * Umbral de incobrabilidad. Pasados los 90 días la cobranza cae fuerte, así que
 * el aviso tiene que llegar ANTES: se alerta sobre la franja 60–90.
 */
export const DIAS_ZONA_INCOBRABLE = 90;
export const DIAS_PREVIO_INCOBRABLE = 60;
/** Salto en puntos porcentuales del top 1 que se considera un cambio real. */
export const SALTO_CONCENTRACION_PP = 5;
/** Participación del top 1 por debajo de la cual el salto no preocupa. */
export const CONCENTRACION_MINIMA_PCT = 30;
/** Caída proyectada del mes que amerita avisar mientras todavía hay margen. */
export const CAIDA_PROYECTADA_PCT = 10;
/**
 * Participación mínima para considerar "grande" a un cliente en el cruce N2.
 * Por debajo de esto, un atraso es un incobrable menor y no una exposición.
 */
export const PARTICIPACION_CLIENTE_GRANDE_PCT = 5;
/** Participación del top 1 a partir de la cual la concentración es crítica. */
export const CONCENTRACION_CRITICA_PCT = 50;
/** Salto en puntos del ratio de notas de crédito que se considera un cambio real. */
export const SALTO_NOTAS_CREDITO_PP = 10;

export type TipoRiesgo =
  | "cliente_en_fuga"
  | "deudor_grande"
  | "deuda_hacia_incobrable"
  | "concentracion_en_alza"
  | "mes_por_debajo"
  | "devoluciones_disparadas";

export interface MontoEnRiesgo {
  moneda: string;
  monto: number;
}

export interface AlertaPlata {
  tipo: TipoRiesgo;
  severidad: Severidad;
  titulo: string;
  /** Qué pasó y por qué importa. */
  detalle: string;
  /** Qué hacer. Sin esto es un diagnóstico, no una alerta. */
  accion: string;
  /** Plata expuesta. Por moneda, sin convertir. */
  monto_en_riesgo: MontoEnRiesgo[];
  /** Datos crudos para que el asistente pueda profundizar sin recalcular. */
  datos: Record<string, unknown>;
}

export interface RiesgoPlataResultado {
  alertas: AlertaPlata[];
  conteo_por_severidad: Record<Severidad, number>;
  /** Qué cruces se pudieron evaluar y cuáles no (y por qué). */
  cobertura: Array<{ tipo: TipoRiesgo; evaluado: boolean; motivo: string | null }>;
  warnings: string[];
}

export interface RiesgoPlataInput {
  /** Ranking del período actual. Es el único insumo obligatorio. */
  ranking_actual: RankingClientesResultado;
  /** Mismo ranking sobre el período INMEDIATAMENTE anterior, de igual duración. */
  ranking_previo?: RankingClientesResultado;
  /** Cuenta corriente para cruzar volumen con atraso. */
  cuenta?: CuentaCorrienteResultado;
  /** Comparación de períodos, para la proyección de cierre. */
  comparacion?: ComparacionResultado;
  umbrales?: Partial<{
    caida_cliente_pct: number;
    top_clientes: number;
    atraso_relevante_dias: number;
    salto_concentracion_pp: number;
    caida_proyectada_pct: number;
  }>;
}

function montoDe(mapa: Record<string, number>, moneda: string): number {
  return mapa[moneda] ?? 0;
}

function nombreDe(c: { rut: string | null; nombre: string | null }): string {
  return c.nombre ?? c.rut ?? "(sin identificar)";
}

function nombreDeSaldo(c: SaldoCliente): string {
  return c.cliente_nombre ?? c.cliente_rut ?? "(sin identificar)";
}

/** Suma un mapa moneda -> {total} a la lista de montos en riesgo. */
function montosDesde(mapa: Record<string, { total: number }>): MontoEnRiesgo[] {
  return Object.entries(mapa)
    .filter(([, v]) => Math.abs(v.total) > 0)
    .map(([moneda, v]) => ({ moneda, monto: round2(v.total) }))
    .sort((a, b) => b.monto - a.monto);
}

// --- N1: cliente bueno que se está yendo ------------------------------------

function clientesEnFuga(
  actual: RankingClientesResultado,
  previo: RankingClientesResultado,
  caidaPct: number,
  topN: number,
): AlertaPlata[] {
  const moneda = previo.moneda_orden;
  const porRut = new Map<string, ClienteRanking>();
  for (const c of actual.clientes) if (c.rut !== null) porRut.set(c.rut, c);

  // `actual.clientes` puede venir recortado por `limite`. Si está recortado, la
  // ausencia de un cliente en esa lista NO prueba que no haya facturado: puede
  // estar más abajo en el ranking. Afirmar "no emitió ningún comprobante" con
  // severidad crítica sobre esa base es afirmar un hecho falso.
  const listaCompleta = actual.clientes.length >= actual.clientes_totales;

  // Se vigilan los que ERAN grandes: un cliente que este mes no compró no
  // aparece en el ranking actual, y es justamente el caso que hay que detectar.
  const vigilados = previo.clientes
    .filter((c) => c.rut !== null && montoDe(c.facturado_por_moneda, moneda) > 0)
    .slice(0, topN);

  const out: AlertaPlata[] = [];
  for (const antes of vigilados) {
    const ahora = porRut.get(antes.rut!);
    const montoAntes = montoDe(antes.facturado_por_moneda, moneda);
    const montoAhora = ahora ? montoDe(ahora.facturado_por_moneda, moneda) : 0;
    const caida = round2(((montoAntes - montoAhora) / montoAntes) * 100);
    if (caida < caidaPct) continue;

    const dejoDeFacturar = round2(montoAntes - montoAhora);
    // "Se fue" solo si no facturó en NINGUNA moneda —un cliente que pasó de
    // pesos a dólares no se fue, cambió de moneda— y solo si podemos saberlo.
    const facturoEnOtraMoneda =
      ahora !== undefined &&
      Object.values(ahora.facturado_por_moneda).some((v) => Math.abs(v) > 0);
    const seFue = montoAhora === 0 && !facturoEnOtraMoneda && listaCompleta;
    out.push({
      tipo: "cliente_en_fuga",
      // Que un top-10 deje de comprar del todo es una pérdida ya ocurrida; una
      // caída parcial todavía se puede revertir con una llamada.
      severidad: seFue ? "critica" : "advertencia",
      titulo: `${nombreDe(antes)} facturó ${caida}% menos que en el período anterior`,
      detalle:
        `Pasó de ${montoAntes} a ${montoAhora} ${moneda}` +
        (seFue
          ? ". No emitió ningún comprobante en el período actual."
          : facturoEnOtraMoneda
            ? ". Ojo: sí facturó en otra moneda, así que puede ser un cambio de moneda y no una caída real."
            : ".") +
        ` Era el cliente #${vigilados.indexOf(antes) + 1} del período anterior` +
        (antes.participacion_pct !== null ? ` (${antes.participacion_pct}% de la facturación).` : "."),
      accion: seFue
        ? "Llamalo antes de que la baja se consolide: un cliente que dejó de comprar rara vez avisa, y a los tres meses ya compró en otro lado."
        : "Revisá si hubo un problema de servicio, precio o stock. Una caída de esta magnitud casi nunca es estacionalidad sola.",
      monto_en_riesgo: [{ moneda, monto: dejoDeFacturar }],
      datos: {
        cliente_rut: antes.rut,
        cliente_nombre: antes.nombre,
        moneda,
        facturado_anterior: montoAntes,
        facturado_actual: montoAhora,
        caida_pct: caida,
        ultima_compra: ahora?.ultima_compra ?? antes.ultima_compra,
      },
    });
  }

  return out;
}

// --- N2: compra mucho y paga tarde ------------------------------------------

function deudoresGrandes(
  actual: RankingClientesResultado,
  cuenta: CuentaCorrienteResultado,
  atrasoRelevante: number,
): AlertaPlata[] {
  const moneda = actual.moneda_orden;
  const participacion = new Map<string, ClienteRanking>();
  for (const c of actual.clientes) if (c.rut !== null) participacion.set(c.rut, c);

  const out: AlertaPlata[] = [];
  for (const saldo of cuenta.por_cliente) {
    if (saldo.cliente_rut === null) continue;
    if (saldo.dias_atraso_maximo < atrasoRelevante) continue;
    const vencido = montosDesde(saldo.vencido_por_moneda);
    if (vencido.length === 0) continue;

    const cliente = participacion.get(saldo.cliente_rut);
    const share = cliente?.participacion_pct ?? null;
    // El cruce es el punto: volumen alto + atraso alto. Un cliente chico
    // atrasado es un incobrable menor; el mismo atraso en el cliente más
    // grande es la empresa financiándolo sin haberlo decidido.
    const esGrande = share !== null && share >= PARTICIPACION_CLIENTE_GRANDE_PCT;
    if (!esGrande) continue;

    const critica = saldo.dias_atraso_maximo >= ATRASO_CRITICO_DIAS;
    out.push({
      tipo: "deudor_grande",
      severidad: critica ? "critica" : "advertencia",
      titulo: `${nombreDeSaldo(saldo)} es ${share}% de tu facturación y está ${saldo.dias_atraso_maximo} días atrasado`,
      detalle:
        `Tiene ${saldo.documentos_pendientes} documento(s) pendientes y ` +
        `${vencido.map((v) => `${v.monto} ${v.moneda}`).join(" + ")} ya vencidos. ` +
        "Es tu mayor exposición: el cliente que más te compra, financiado por vos.",
      accion:
        "Antes de seguir vendiéndole a crédito, acordá un plan de pago o un tope. " +
        "Cortarle el crédito de golpe al cliente más grande es peor: lo que hay que hacer es decidirlo, no descubrirlo.",
      monto_en_riesgo: vencido,
      datos: {
        cliente_rut: saldo.cliente_rut,
        cliente_nombre: saldo.cliente_nombre,
        participacion_pct: share,
        moneda_participacion: moneda,
        dias_atraso_maximo: saldo.dias_atraso_maximo,
        documentos_pendientes: saldo.documentos_pendientes,
        estrategia_imputacion: cuenta.estrategia,
      },
    });
  }

  return out;
}

// --- N3: deuda entrando en zona incobrable ----------------------------------

function deudaHaciaIncobrable(cuenta: CuentaCorrienteResultado): AlertaPlata[] {
  const enFranja = cuenta.documentos.filter((d) => {
    if (d.saldo <= 0 || d.dias_para_vencer === null) return false;
    const atraso = -d.dias_para_vencer;
    return atraso >= DIAS_PREVIO_INCOBRABLE && atraso < DIAS_ZONA_INCOBRABLE;
  });
  const yaCruzada = cuenta.documentos.filter(
    (d) => d.saldo > 0 && d.dias_para_vencer !== null && -d.dias_para_vencer >= DIAS_ZONA_INCOBRABLE,
  );

  const out: AlertaPlata[] = [];
  const acumular = (docs: typeof enFranja): MontoEnRiesgo[] => {
    const mapa: Record<string, { total: number }> = {};
    for (const d of docs) (mapa[d.moneda] ??= { total: 0 }).total = round2((mapa[d.moneda]!.total) + d.saldo);
    return montosDesde(mapa);
  };

  if (enFranja.length > 0) {
    const diasRestantes = Math.min(
      ...enFranja.map((d) => DIAS_ZONA_INCOBRABLE + (d.dias_para_vencer ?? 0)),
    );
    out.push({
      tipo: "deuda_hacia_incobrable",
      severidad: "advertencia",
      titulo: `${enFranja.length} factura(s) están por cruzar los ${DIAS_ZONA_INCOBRABLE} días de atraso`,
      detalle:
        `Están entre ${DIAS_PREVIO_INCOBRABLE} y ${DIAS_ZONA_INCOBRABLE} días vencidas; la más ` +
        `avanzada cruza el umbral en ${diasRestantes} día(s). Pasado ese punto la probabilidad de ` +
        "cobrar cae fuerte, y el reclamo pasa de ser una gestión a ser un conflicto.",
      accion:
        "Gestionalas esta semana, mientras todavía es un recordatorio y no una intimación. " +
        "Empezá por las de monto mayor de la lista.",
      monto_en_riesgo: acumular(enFranja),
      datos: {
        documentos: enFranja.slice(0, 20),
        dias_hasta_el_umbral: diasRestantes,
        estrategia_imputacion: cuenta.estrategia,
      },
    });
  }

  if (yaCruzada.length > 0) {
    out.push({
      tipo: "deuda_hacia_incobrable",
      severidad: "critica",
      titulo: `${yaCruzada.length} factura(s) llevan más de ${DIAS_ZONA_INCOBRABLE} días vencidas`,
      detalle:
        "Ya cruzaron el umbral en el que la cobranza deja de ser gestión comercial. " +
        "Cada mes que pasa la recuperación es menor.",
      accion:
        "Decidí explícitamente qué hacés con cada una: plan de pago, gestión externa o darla por " +
        "perdida. Dejarlas en el listado sin decisión es la opción más cara de las tres.",
      monto_en_riesgo: acumular(yaCruzada),
      datos: {
        documentos: yaCruzada.slice(0, 20),
        estrategia_imputacion: cuenta.estrategia,
      },
    });
  }

  return out;
}

// --- N4: la concentración subió ---------------------------------------------

function concentracionEnAlza(
  actual: RankingClientesResultado,
  previo: RankingClientesResultado,
  saltoPp: number,
): AlertaPlata[] {
  const a = actual.concentracion;
  const p = previo.concentracion;
  if (a === null || p === null) return [];
  if (a.moneda !== p.moneda) return [];

  const salto = round2(a.top_1_pct - p.top_1_pct);
  if (salto < saltoPp || a.top_1_pct < CONCENTRACION_MINIMA_PCT) return [];

  const lider = actual.clientes.find((c) => c.rut !== null) ?? null;
  return [
    {
      tipo: "concentracion_en_alza",
      severidad: a.top_1_pct >= CONCENTRACION_CRITICA_PCT ? "critica" : "advertencia",
      titulo: `Tu cliente más grande pasó del ${p.top_1_pct}% al ${a.top_1_pct}% de la facturación`,
      detalle:
        `Subió ${salto} puntos en un período (HHI ${p.hhi} → ${a.hhi}). ${a.interpretacion} ` +
        "La dependencia crece de a poco y se nota recién cuando ese cliente se va o pide plazo.",
      accion:
        "No es para cortar con nadie: es para que la próxima venta que persigas sea de otro cliente. " +
        "Si el top 1 pasa del 50%, el plan comercial del trimestre tendría que ser diversificar.",
      monto_en_riesgo: lider
        ? [{ moneda: a.moneda, monto: montoDe(lider.facturado_por_moneda, a.moneda) }]
        : [],
      datos: {
        top_1_pct_anterior: p.top_1_pct,
        top_1_pct_actual: a.top_1_pct,
        salto_pp: salto,
        hhi_anterior: p.hhi,
        hhi_actual: a.hhi,
        cliente_lider: lider ? { rut: lider.rut, nombre: lider.nombre } : null,
      },
    },
  ];
}

// --- N5: vas atrasado contra tu propio mes ----------------------------------

function mesPorDebajo(comparacion: ComparacionResultado, caidaPct: number): AlertaPlata[] {
  const p = comparacion.proyeccion;
  if (p === null || p.variacion_proyectada_pct === null) return [];
  if (p.variacion_proyectada_pct > -caidaPct) return [];

  const diasRestantes = p.dias_del_periodo - p.dias_transcurridos;
  // Lo que falta facturar en los días que quedan se mide contra lo YA facturado,
  // no contra la proyección: la proyección incluye ventas que todavía no
  // ocurrieron, así que restarla da un número más chico que el esfuerzo real.
  const faltante = round2(
    (comparacion.anterior.total_por_moneda[p.moneda] ?? 0) - p.facturado_hasta_ahora,
  );

  return [
    {
      tipo: "mes_por_debajo",
      // Con margen para reaccionar es una advertencia; sobre el final del
      // período ya es un hecho consumado y avisarlo como urgente no ayuda.
      severidad: diasRestantes >= 7 ? "advertencia" : "info",
      titulo: `El período proyecta cerrar ${Math.abs(p.variacion_proyectada_pct)}% por debajo del anterior`,
      detalle:
        `Llevás ${p.facturado_hasta_ahora} ${p.moneda} en ${p.dias_transcurridos} de ` +
        `${p.dias_del_periodo} días; al ritmo actual el cierre da ${p.proyectado_al_cierre} ${p.moneda}. ` +
        `Quedan ${diasRestantes} día(s). ${p.advertencia}`,
      accion:
        diasRestantes >= 7
          ? `Faltan ~${faltante} ${p.moneda} para igualar el período anterior y hay ${diasRestantes} días para hacerlos. Mirá el listado de clientes dormidos: es la vía más rápida.`
          : "Ya casi no hay margen para revertirlo en este período. Sirve para planificar el próximo, no para correr.",
      monto_en_riesgo: [{ moneda: p.moneda, monto: faltante > 0 ? faltante : 0 }],
      datos: {
        moneda: p.moneda,
        facturado_hasta_ahora: p.facturado_hasta_ahora,
        proyectado_al_cierre: p.proyectado_al_cierre,
        periodo_anterior: comparacion.anterior.total_por_moneda[p.moneda] ?? 0,
        variacion_proyectada_pct: p.variacion_proyectada_pct,
        dias_restantes: diasRestantes,
        metodo: p.metodo,
      },
    },
  ];
}

// --- N6: devoluciones que se dispararon -------------------------------------

function devolucionesDisparadas(
  actual: RankingClientesResultado,
  previo: RankingClientesResultado | undefined,
): AlertaPlata[] {
  const moneda = actual.moneda_orden;
  const previoPorRut = new Map<string, ClienteRanking>();
  for (const c of previo?.clientes ?? []) if (c.rut !== null) previoPorRut.set(c.rut, c);

  const out: AlertaPlata[] = [];
  for (const c of actual.clientes) {
    if (!c.nc_anomalas || c.ratio_notas_credito_pct === null) continue;
    const antes = c.rut !== null ? previoPorRut.get(c.rut) : undefined;
    const ratioAntes = antes?.ratio_notas_credito_pct ?? null;
    // Un ratio alto y estable puede ser el modelo de negocio (consignación,
    // devoluciones habituales). Lo que amerita mirar es el SALTO.
    const salto = ratioAntes !== null ? round2(c.ratio_notas_credito_pct - ratioAntes) : null;
    if (previo !== undefined && salto !== null && salto < SALTO_NOTAS_CREDITO_PP) continue;

    out.push({
      tipo: "devoluciones_disparadas",
      severidad: "advertencia",
      titulo: `${nombreDe(c)} tiene ${c.ratio_notas_credito_pct}% de notas de crédito`,
      detalle:
        (salto !== null
          ? `Saltó ${salto} puntos contra el período anterior (${ratioAntes}%). `
          : "No hay período anterior para comparar, así que es un nivel alto, no necesariamente un salto. ") +
        `Emitiste ${c.cantidad_notas_credito} nota(s) de crédito sobre ${c.comprobantes} comprobante(s).`,
      accion:
        "Mirá las notas de crédito una por una: si son errores de facturación se corrige el proceso, " +
        "si son devoluciones reales hay un problema de producto o de expectativa que la factura no arregla.",
      monto_en_riesgo: [
        { moneda, monto: montoDe(c.notas_credito_por_moneda, moneda) },
      ],
      datos: {
        cliente_rut: c.rut,
        cliente_nombre: c.nombre,
        ratio_actual_pct: c.ratio_notas_credito_pct,
        ratio_anterior_pct: ratioAntes,
        salto_pp: salto,
        cantidad_notas_credito: c.cantidad_notas_credito,
      },
    });
  }

  return out;
}

// --- Composición ------------------------------------------------------------

export function detectarRiesgoPlata(input: RiesgoPlataInput): RiesgoPlataResultado {
  const u = input.umbrales ?? {};
  const caidaCliente = u.caida_cliente_pct ?? CAIDA_CLIENTE_PCT;
  const topN = u.top_clientes ?? TOP_CLIENTES_VIGILADOS;
  const atraso = u.atraso_relevante_dias ?? ATRASO_RELEVANTE_DIAS;
  const saltoConc = u.salto_concentracion_pp ?? SALTO_CONCENTRACION_PP;
  const caidaProy = u.caida_proyectada_pct ?? CAIDA_PROYECTADA_PCT;

  const alertas: AlertaPlata[] = [];
  const cobertura: RiesgoPlataResultado["cobertura"] = [];
  const warnings: string[] = [];

  const marcar = (tipo: TipoRiesgo, evaluado: boolean, motivo: string | null): void => {
    cobertura.push({ tipo, evaluado, motivo });
  };

  if (input.ranking_previo !== undefined) {
    alertas.push(...clientesEnFuga(input.ranking_actual, input.ranking_previo, caidaCliente, topN));
    marcar("cliente_en_fuga", true, null);
    alertas.push(...concentracionEnAlza(input.ranking_actual, input.ranking_previo, saltoConc));
    marcar("concentracion_en_alza", true, null);
  } else {
    const motivo = "Falta el período anterior: la fuga y el salto de concentración se miden contra la propia historia del negocio.";
    marcar("cliente_en_fuga", false, motivo);
    marcar("concentracion_en_alza", false, motivo);
  }

  if (input.cuenta !== undefined) {
    alertas.push(...deudoresGrandes(input.ranking_actual, input.cuenta, atraso));
    alertas.push(...deudaHaciaIncobrable(input.cuenta));
    marcar("deudor_grande", true, null);
    marcar("deuda_hacia_incobrable", true, null);
    if (!input.cuenta.imputacion_exacta) {
      warnings.push(
        `La imputación de cobros fue "${input.cuenta.estrategia}": el saldo POR FACTURA es una ` +
          "estimación (FIFO), no una imputación declarada por el recibo. El saldo total por cliente " +
          "sí es exacto. Las alertas de deuda heredan ese límite.",
      );
    }
  } else {
    const motivo = "Sin cuenta corriente no se puede cruzar volumen con atraso ni medir la deuda vieja.";
    marcar("deudor_grande", false, motivo);
    marcar("deuda_hacia_incobrable", false, motivo);
  }

  if (input.comparacion !== undefined) {
    alertas.push(...mesPorDebajo(input.comparacion, caidaProy));
    marcar("mes_por_debajo", true, null);
  } else {
    marcar("mes_por_debajo", false, "Falta la comparación de períodos (proyección de cierre).");
  }

  alertas.push(...devolucionesDisparadas(input.ranking_actual, input.ranking_previo));
  marcar("devoluciones_disparadas", true, null);

  // Orden: primero lo grave; a igual gravedad, primero lo que más plata mueve.
  const mayorMonto = (a: AlertaPlata): number =>
    a.monto_en_riesgo.reduce((max, m) => Math.max(max, Math.abs(m.monto)), 0);
  alertas.sort(
    (a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad] || mayorMonto(b) - mayorMonto(a),
  );

  const conteo_por_severidad: Record<Severidad, number> = { critica: 0, advertencia: 0, info: 0 };
  for (const a of alertas) conteo_por_severidad[a.severidad] += 1;

  return { alertas, conteo_por_severidad, cobertura, warnings };
}
