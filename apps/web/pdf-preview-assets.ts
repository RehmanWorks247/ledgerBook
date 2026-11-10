import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// Ship the matching PDF.js fonts and decoders locally, including CMaps for
// international documents. No runtime CDN or third-party viewer is involved.
export function pdfPreviewAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const prefix = `pdf-assets/${version}/`;
  const files = new Map<string, string>();
  for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    for (const file of readdirSync(join(root, directory))) files.set(`${prefix}${directory}/${file}`, join(root, directory, file));
  }
  return {
    name: "private-file-preview-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get((req.url || "").split("?")[0].slice(1));
        if (!file) return next();
        res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, path] of files) this.emitFile({ type: "asset", fileName, source: readFileSync(path) });
    },
  };
}
