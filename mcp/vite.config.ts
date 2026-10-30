import { defineConfig } from "vite";

// Bundles the server and its dependencies into one Node script for npm.
export default defineConfig({
  build: {
    ssr: "mcp/main.ts",
    outDir: "mcp/dist",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: {
      output: {
        entryFileNames: "flutrace-mcp.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
  ssr: { noExternal: true, target: "node" },
});
