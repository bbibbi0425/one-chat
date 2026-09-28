import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";
import path from "node:path";
const root = new URL("../dist/", import.meta.url);
test("production artifact works under a project path and contains only a static app", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /script-src 'self';/); assert.doesNotMatch(html, /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]);
  assert.ok(assets.some(a => a.endsWith(".js")));
  for (const asset of assets) { assert.ok(asset.startsWith("./"), asset); await access(new URL(asset, root)); assert.ok(new URL(asset, "https://example.com/one-chat/").pathname.startsWith("/one-chat/")); }
  await access(new URL(".nojekyll", root));
  await assert.rejects(access(new URL("server/index.js", root)));
  const manifest = JSON.parse(await readFile(new URL(".openai/hosting.json", root), "utf8")); assert.equal(manifest.d1, null); assert.equal(manifest.r2, null);
  for (const file of await readdir(new URL("assets/", root))) {
    assert.notEqual(path.extname(file), ".map");
    if (file.endsWith(".js")) { const js = await readFile(new URL(`assets/${file}`, root), "utf8"); assert.equal(js.includes("/api/rooms"), false); }
  }
});
