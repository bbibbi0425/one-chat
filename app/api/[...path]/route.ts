import { getDatabase } from "@/db";
import { handleApi } from "@/lib/server";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  try { return await handleApi(request, getDatabase()); }
  catch { return Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export { handle as GET, handle as POST };
