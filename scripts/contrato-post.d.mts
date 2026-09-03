export interface ProbePostOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  archivos?: {
    readFile(path: string): string;
    stat(path: string): { mode: number };
  };
}

export function ejecutarProbePost(options?: ProbePostOptions): Promise<{
  statusPrimero: number;
  statusSegundo: number;
  coincidencias: number;
  idempotencyKeyConfirmada: boolean;
  reintento: "rechazado_por_numero_interno_duplicado" | "aceptado_con_la_misma_clave";
}>;
