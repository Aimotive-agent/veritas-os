import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    // Emit brand/avatar images as real files (relative URLs), never inline data URLs:
    // the under-file:// renderer must resolve them next to index.html.
    assetsInlineLimit: 0,
    rollupOptions: { output: { assetFileNames: "assets/[name]-[hash][extname]" } }
  }
})
