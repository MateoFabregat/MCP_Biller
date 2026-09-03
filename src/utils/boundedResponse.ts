// Lee respuestas HTTP sin permitir que un upstream agote la memoria del proceso.
// Biller puede devolver listados grandes, por eso el límite es holgado; aun así,
// una respuesta que lo supera se corta en el borde de red, antes de parsearla.

export interface BoundedText {
  text: string;
  truncated: boolean;
}

export async function readTextBounded(res: Response, maxBytes: number): Promise<BoundedText> {
  if (!res.body) return { text: "", truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const disponibles = maxBytes - bytes;
      if (value.byteLength > disponibles) {
        if (disponibles > 0) text += decoder.decode(value.subarray(0, disponibles), { stream: true });
        await reader.cancel();
        return { text: text + decoder.decode(), truncated: true };
      }

      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), truncated: false };
  } finally {
    reader.releaseLock();
  }
}
