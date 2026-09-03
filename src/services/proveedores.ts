// =============================================================================
// Compras por proveedor, sobre los comprobantes RECIBIDOS de DGI.
//
// Es el espejo del ranking de clientes, pero con una diferencia importante que
// hay que decir en la respuesta y no solo acá:
//
//   ESTO ES EL DEVENGADO, NO EL PAGADO. Un comprobante recibido significa que
//   el proveedor te facturó, no que vos le pagaste. Biller no expone tus pagos
//   a proveedores, así que "¿cuánto le debo a X?" NO se contesta con esto.
//
// La otra diferencia: los recibidos NO traen razón social del emisor, solo
// `rut_emisor`. El nombre se puede resolver contra DGI
// (/v2/dgi/empresas/nombre-entidad), pero es 1 request por proveedor con límite
// de 1 req/seg — por eso es opcional y acotado a los primeros N.
// =============================================================================

import { round2 } from "../biller/coerce.js";
import type { ComprobanteRecibido } from "../biller/types.js";
import { monedaDeOrden } from "./monedaOrden.js";
import { classifyCfe } from "./cfeTypes.js";

/** Estados de un recibido que NO representan una compra válida. */
function esValido(r: ComprobanteRecibido): boolean {
  return r.estado === null || !/rechazado/i.test(r.estado);
}

export interface ProveedorRanking {
  rut_emisor: string | null;
  /** Razón social, si se resolvió contra DGI. */
  nombre: string | null;
  /** Total comprado por moneda (sin convertir). */
  total_por_moneda: Record<string, number>;
  iva_por_moneda: Record<string, number>;
  neto_por_moneda: Record<string, number>;
  retenido_por_moneda: Record<string, number>;
  comprobantes: number;
  primera_compra: string | null;
  ultima_compra: string | null;
  /** % del total comprado, en la moneda de ordenamiento. */
  participacion_pct: number | null;
}

export interface ProveedoresResultado {
  proveedores: ProveedorRanking[];
  moneda_orden: string;
  monedas_presentes: string[];
  total_por_moneda: Record<string, number>;
  iva_credito_por_moneda: Record<string, number>;
  retenciones_por_moneda: Record<string, number>;
  proveedores_totales: number;
  comprobantes_analizados: number;
  concentracion_top_3_pct: number | null;
  warnings: string[];
}

export interface ProveedoresOptions {
  moneda?: string;
  limite?: number;
}

function sumar(mapa: Record<string, number>, moneda: string, monto: number): void {
  mapa[moneda] = round2((mapa[moneda] ?? 0) + monto);
}

export function rankingProveedores(
  recibidos: ComprobanteRecibido[],
  opciones: ProveedoresOptions = {},
): ProveedoresResultado {
  const limite = opciones.limite ?? 20;
  const warnings: string[] = [];

  const porRut = new Map<string, ProveedorRanking>();
  const totalPorMoneda: Record<string, number> = {};
  const ivaPorMoneda: Record<string, number> = {};
  const retenidoPorMoneda: Record<string, number> = {};
  let analizados = 0;
  let rechazados = 0;
  let sinMoneda = 0;

  for (const r of recibidos) {
    if (!esValido(r)) {
      rechazados += 1;
      continue;
    }
    if (r.moneda === null) {
      sinMoneda += 1;
      continue;
    }

    const clave = r.rut_emisor ?? "(sin RUT)";
    const actual: ProveedorRanking = porRut.get(clave) ?? {
      rut_emisor: r.rut_emisor,
      nombre: null,
      total_por_moneda: {},
      iva_por_moneda: {},
      neto_por_moneda: {},
      retenido_por_moneda: {},
      comprobantes: 0,
      primera_compra: null,
      ultima_compra: null,
      participacion_pct: null,
    };

    // Las NC recibidas reducen la compra, el IVA crédito y las retenciones. La
    // API entrega importes positivos: el signo fiscal vive en el tipo de CFE.
    const esNotaCredito = classifyCfe(r.tipo).signo === -1;
    const firmado = (valor: number | null): number =>
      esNotaCredito ? -Math.abs(valor ?? 0) : (valor ?? 0);
    const total = firmado(r.monto_total);
    sumar(actual.total_por_moneda, r.moneda, total);
    sumar(actual.iva_por_moneda, r.moneda, firmado(r.total_iva));
    sumar(actual.neto_por_moneda, r.moneda, firmado(r.total_neto));
    sumar(actual.retenido_por_moneda, r.moneda, firmado(r.total_retenido));
    sumar(totalPorMoneda, r.moneda, total);
    sumar(ivaPorMoneda, r.moneda, firmado(r.total_iva));
    sumar(retenidoPorMoneda, r.moneda, firmado(r.total_retenido));
    actual.comprobantes += 1;

    if (r.fecha !== null) {
      const f = r.fecha.slice(0, 10);
      if (actual.primera_compra === null || f < actual.primera_compra) actual.primera_compra = f;
      if (actual.ultima_compra === null || f > actual.ultima_compra) actual.ultima_compra = f;
    }

    porRut.set(clave, actual);
    analizados += 1;
  }

  const monedasPresentes = Object.keys(totalPorMoneda).sort();
  const monedaOrden = monedaDeOrden(totalPorMoneda, opciones.moneda);

  const totalOrden = totalPorMoneda[monedaOrden] ?? 0;
  const proveedores = [...porRut.values()];
  for (const p of proveedores) {
    const monto = p.total_por_moneda[monedaOrden] ?? 0;
    p.participacion_pct = totalOrden > 0 ? round2((monto / totalOrden) * 100) : null;
  }
  proveedores.sort(
    (a, b) => (b.total_por_moneda[monedaOrden] ?? 0) - (a.total_por_moneda[monedaOrden] ?? 0),
  );

  const top3 =
    totalOrden > 0
      ? round2(
          proveedores
            .slice(0, 3)
            .reduce((acc, p) => acc + (p.total_por_moneda[monedaOrden] ?? 0), 0) /
            totalOrden *
            100,
        )
      : null;

  // El caveat central de esta tool viaja SIEMPRE, no solo cuando algo sale mal.
  warnings.push(
    "Estos montos son el DEVENGADO: lo que tus proveedores te facturaron, no lo que vos les " +
      "pagaste. Biller no expone tus pagos a proveedores, así que esto NO responde '¿cuánto le debo a X?'.",
  );
  if (monedasPresentes.length > 1) {
    warnings.push(
      `Hay compras en ${monedasPresentes.length} monedas (${monedasPresentes.join(", ")}). ` +
        `El ranking se ordena por ${monedaOrden}; los montos NO se convierten.`,
    );
  }
  if (rechazados > 0) {
    warnings.push(`${rechazados} comprobante(s) recibidos rechazados por DGI: excluidos del total.`);
  }
  if (sinMoneda > 0) {
    warnings.push(`${sinMoneda} comprobante(s) recibidos sin moneda: excluidos del cálculo.`);
  }
  if (porRut.has("(sin RUT)")) {
    warnings.push(
      "Hay comprobantes sin RUT de emisor identificable: se agruparon como '(sin RUT)' y NO son un proveedor real.",
    );
  }

  return {
    proveedores: proveedores.slice(0, limite),
    moneda_orden: monedaOrden,
    monedas_presentes: monedasPresentes,
    total_por_moneda: totalPorMoneda,
    iva_credito_por_moneda: ivaPorMoneda,
    retenciones_por_moneda: retenidoPorMoneda,
    proveedores_totales: porRut.size,
    comprobantes_analizados: analizados,
    concentracion_top_3_pct: top3,
    warnings,
  };
}
