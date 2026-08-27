// =============================================================================
// Liveness sin autenticación: GET /api/healthz
//
// Devuelve SOLO si el proceso está vivo y si las variables mínimas existen.
// Nunca valores: ni el token de Biller, ni el del transporte, ni la base URL.
// Un health check que filtra configuración es un endpoint de reconocimiento
// gratis para quien esté escaneando.
// =============================================================================

export default function handler(_req, res) {
  res.status(200).json({
    status: "ok",
    transport: "serverless",
    // Booleanos, no valores. Alcanza para diagnosticar "no configuraste X".
    configurado: {
      biller_base_url: Boolean(process.env.BILLER_API_BASE_URL),
      biller_token: Boolean(process.env.BILLER_API_TOKEN),
      http_auth_token: Boolean(process.env.BILLER_HTTP_AUTH_TOKEN),
      kapso: Boolean(process.env.KAPSO_API_KEY),
    },
  });
}
