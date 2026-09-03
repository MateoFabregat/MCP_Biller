import { logger } from "../logger.js";
import type { ContextosPorTenant } from "./contextos.js";
import type { HolderRegistroTenants } from "./holder.js";
import { cargarTenants, type RegistroTenants } from "./registry.js";

export type ResultadoRecargaTenants =
  | { estado: "sin_fuente" }
  | { estado: "error" }
  | { estado: "recargado"; afectados: string[]; sesionesCerradas: number };

interface OpcionesRecargaTenants {
  env: Record<string, string | undefined>;
  holder: HolderRegistroTenants;
  contextos: ContextosPorTenant;
  cerrarSesiones: (tenantIds: readonly string[]) => number;
  cargar?: (env: Record<string, string | undefined>) => RegistroTenants;
}

function tieneFuente(env: Record<string, string | undefined>): boolean {
  return (env.BILLER_TENANTS_JSON ?? "").trim() !== "" ||
    (env.BILLER_TENANTS_PATH ?? "").trim() !== "";
}

/**
 * Crea el handler síncrono usado por SIGHUP. La carga y validación completa
 * ocurren antes de cualquier mutación; la publicación queda para el final.
 */
export function crearManejadorRecargaTenants(
  opciones: OpcionesRecargaTenants,
): () => ResultadoRecargaTenants {
  return () => {
    if (!tieneFuente(opciones.env)) return { estado: "sin_fuente" };

    let siguiente: RegistroTenants;
    try {
      siguiente = (opciones.cargar ?? cargarTenants)(opciones.env);
    } catch (err) {
      logger.error("tenants.recarga.rechazada", {
        message: err instanceof Error ? err.message : String(err),
      });
      return { estado: "error" };
    }

    const anterior = opciones.holder.actual();
    const afectados = opciones.contextos.invalidarCambios(anterior, siguiente);
    const sesionesCerradas = opciones.cerrarSesiones(afectados);
    opciones.holder.reemplazar(siguiente);

    logger.info("tenants.recarga.completada", {
      empresas: siguiente.tenants.map((tenant) => tenant.id),
      afectados,
      sesiones_cerradas: sesionesCerradas,
    });
    return { estado: "recargado", afectados, sesionesCerradas };
  };
}
