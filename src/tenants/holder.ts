import type { RegistroTenants } from "./registry.js";

/** Lectura del snapshot vigente del registro. Cada request debe leerlo una sola vez. */
export interface FuenteRegistroTenants {
  actual(): RegistroTenants;
}

/**
 * Referencia mutable al registro ya validado.
 *
 * Construir y validar el siguiente registro ocurre antes de llamar a
 * `reemplazar`; la asignación es el único punto de publicación, por lo que un
 * lector nunca puede observar un registro a medio construir.
 */
export class HolderRegistroTenants implements FuenteRegistroTenants {
  constructor(private snapshot: RegistroTenants) {}

  actual(): RegistroTenants {
    return this.snapshot;
  }

  reemplazar(siguiente: RegistroTenants): void {
    this.snapshot = siguiente;
  }
}
