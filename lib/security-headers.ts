export function secureResponse(response: Response, development = false): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Framework hydration uses inline scripts. No external script, analytics or font origins.
  headers.set("Content-Security-Policy", `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${development ? " ws://localhost:* ws://127.0.0.1:*" : ""}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
