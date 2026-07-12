import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const srcPath = fileURLToPath(new URL("./src/", import.meta.url));

// Tauri expects a fixed port, fail if that port is not available
export default defineConfig({
  plugins: react(),
  resolve: {
    alias: [{ find: /^@\//, replacement: srcPath }],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/target/**",
        "**/.git/**",
        "**/.tsbuild-node/**",
        "**/.playwright-mcp/**",
        "**/tests/**",
        "**/.omo/**",
        "**/.opencode/**",
        "**/.codegraph/**",
        "**/.impeccable/**",
        "**/.githooks/**",
        "**/Cargo.lock",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
});
