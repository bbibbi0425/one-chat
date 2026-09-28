import { env } from "cloudflare:workers";
export function getDatabase(): D1Database {
  if (!env.DB) throw new Error("DB_UNAVAILABLE");
  return env.DB;
}
