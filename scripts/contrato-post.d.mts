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
}>;
