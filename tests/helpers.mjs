import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleApi } from "../lib/server.ts";
import { randomToken } from "../lib/protocol.ts";

export function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  sqlite.function("unixepoch", () => Math.floor(clock.now / 1000));
  for (const name of readdirSync("drizzle").filter(n => n.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`drizzle/${name}`, "utf8"));
  const db = {
    before: null,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() { db.before?.(sql); return sqlite.prepare(sql).get(...params) ?? null; },
        async all() { db.before?.(sql); return { results: sqlite.prepare(sql).all(...params) }; },
        async run() { db.before?.(sql); return sqlite.prepare(sql).run(...params); },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  async function request(path, token, body, options = {}) {
    return handleApi(new Request(`https://one-chat.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: "https://one-chat.test", "CF-Connecting-IP": "127.0.0.1", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), db);
  }
  async function create() {
    const inviteToken = randomToken();
    const response = await request("/api/rooms", inviteToken, {});
    if (response.status !== 201) throw new Error(await response.text());
    const { room } = await response.json();
    const joined = await request(`/api/rooms/${room.id}/join`, inviteToken, {});
    return { ...(await joined.json()), inviteToken };
  }
  return { db, sqlite, clock, request, create, close: () => sqlite.close() };
}
