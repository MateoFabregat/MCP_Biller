// =============================================================================
// Endpoint MCP en Vercel:  POST https://<tu-deploy>.vercel.app/api/mcp
//
// Esta es la URL que se le pone al Agent Node de Kapso.
//
// Está en JavaScript plano y NO en TypeScript a propósito: importa desde
// `dist/`, que ya es JS compilado con las extensiones `.js` que exige NodeNext.
// Escribirlo en TS obligaría al bundler de Vercel a resolver imports `.js` que
// apuntan a archivos `.ts`, que es justo donde ese pipeline se rompe. El
// typecheck real vive en `src/`; acá solo hay un adaptador de tres líneas.
// =============================================================================

import { manejarRequestServerless } from "../dist/transport/serverless.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    // Kapso y varios clientes MCP hacen un GET de sondeo. En stateless no hay
    // stream server-initiated que ofrecer, así que se contesta sin ambigüedad.
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Este endpoint funciona en modo stateless: usá POST. " +
          "El streaming server-initiated (GET/SSE) no está disponible en serverless.",
      },
      id: null,
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Método ${req.method} no soportado.` },
      id: null,
    });
    return;
  }

  try {
    await manejarRequestServerless(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Error interno del server MCP." },
        id: null,
      });
    }
    // El detalle va a los logs de Vercel, no al cliente.
    console.error("mcp.handler.error", err instanceof Error ? err.message : String(err));
  }
}
