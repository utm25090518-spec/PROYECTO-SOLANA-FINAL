import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// nodePolyfills hace falta porque web3.js y anchor usan Buffer en el navegador
export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true } })],
});
