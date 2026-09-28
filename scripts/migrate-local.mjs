import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
// Wrangler's migration tracking prevents replaying already applied migrations.
const config = JSON.parse(readFileSync("dist/server/wrangler.json", "utf8"));
config.d1_databases = config.d1_databases.map(binding => ({ ...binding, migrations_dir: path.resolve("drizzle") }));
mkdirSync(".sites-runtime", { recursive: true });
writeFileSync(".sites-runtime/migrations.json", JSON.stringify({ name: "one-chat-migrations", compatibility_date: "2026-09-28", d1_databases: config.d1_databases }));
const result = spawnSync(process.execPath, ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "DB", "--local", "--config", ".sites-runtime/migrations.json", "--persist-to", ".wrangler/state"], { stdio: "inherit" });
process.exit(result.status ?? 1);
