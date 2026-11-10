import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfPreviewAssets } from "./pdf-preview-assets.ts";

export default defineConfig({
  plugins: [react(), pdfPreviewAssets()],
  optimizeDeps: { include: ["mammoth", "fflate", "dompurify", "pdfjs-dist"] },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { sourcemap: false },
});
