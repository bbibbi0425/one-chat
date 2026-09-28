import handler from "vinext/server/fetch-handler";
import { cleanupExpired } from "./lib/server";
import { secureResponse } from "./lib/security-headers";
const worker = {
  async fetch(...args: Parameters<typeof handler.fetch>) {
    return secureResponse(await handler.fetch(...args), import.meta.env.DEV);
  },
  async scheduled(_event: ScheduledController, env: Cloudflare.Env) {
    if (!env.DB) throw new Error("DB_UNAVAILABLE");
    await cleanupExpired(env.DB);
  },
};

export default worker;
