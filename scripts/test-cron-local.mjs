import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

// Run the built Worker directly: the assets proxy does not forward scheduled events.
const config = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
const serverRoot = path.resolve("dist/server");
const modulePaths = ["index.js", ...readdirSync(serverRoot, { recursive: true }).filter(name => name.endsWith(".js") && name !== "index.js")];
const runtime = new Miniflare({
  name: "one-chat-cron-test",
  modules: modulePaths.map(name => ({ type: "ESModule", path: path.join(serverRoot, name) })),
  modulesRoot: serverRoot,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  d1Databases: ["DB"], cf: false, unsafeTriggerHandlers: true,
});
try {
  const db = await runtime.getD1Database("DB");
  for (const name of readdirSync("drizzle").filter(n => n.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(`drizzle/${name}`, "utf8").split("--> statement-breakpoint")) {
      if (sql.trim()) await db.prepare(sql).run();
    }
  }
  await db.prepare("INSERT INTO rooms VALUES ('expired-test', 'hash', 0, 1)").run();
  await db.prepare("INSERT INTO members VALUES ('member-test', 'expired-test', 'session-hash')").run();
  await db.prepare("INSERT INTO messages (id, room_id, sender_id, iv, ciphertext, created_at) VALUES ('message-test', 'expired-test', 'member-test', 'iv', 'cipher', 0)").run();
  const response = await runtime.dispatchFetch("http://localhost/cdn-cgi/handler/scheduled");
  assert.equal(response.status, 200, await response.text());
  for (const table of ["rooms", "members", "messages"]) {
    const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first();
    assert.equal(row.n, 0);
  }
  console.log("PASS: built Worker scheduled handler and D1 expiry cascade (isolated database)");
} finally { await runtime.dispose(); }
