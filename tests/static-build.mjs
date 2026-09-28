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
  // Every original sticker is in the initial JS bundle: no per-sticker image requests.
  const scriptAssets = assets.filter(asset => asset.endsWith(".js"));
  const bundledCode = (await Promise.all(scriptAssets.map(asset => readFile(new URL(asset, root), "utf8")))).join("\n");
  for (const name of ["dance", "love", "happy", "wow", "smile", "blank"]) {
    const png = await readFile(new URL(`../assets/stickers/bo-${name}-v1.png`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 210); assert.equal(png.readUInt32BE(20), 210);
    assert.ok(png.length < 50000);
    assert.ok(bundledCode.includes(`data:image/png;base64,${png.toString("base64")}`));
  }
  await access(new URL(".nojekyll", root));
  await assert.rejects(access(new URL("server/index.js", root)));
  const manifest = JSON.parse(await readFile(new URL(".openai/hosting.json", root), "utf8")); assert.equal(manifest.d1, null); assert.equal(manifest.r2, null);
  for (const file of await readdir(new URL("assets/", root))) {
    assert.notEqual(path.extname(file), ".map");
    if (file.endsWith(".js")) { const js = await readFile(new URL(`assets/${file}`, root), "utf8"); assert.equal(js.includes("/api/rooms"), false); }
  }
});
