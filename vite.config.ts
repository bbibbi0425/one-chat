import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { sites } from "./build/sites-vite-plugin";
export default defineConfig({
  base: "./",
  plugins: [react(), sites({ mockAuth: false }), {
    name: "development-csp", apply: "serve",
    transformIndexHtml(html) { return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"); },
  }],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5173 },
  preview: { host: "127.0.0.1", port: 4173 },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
