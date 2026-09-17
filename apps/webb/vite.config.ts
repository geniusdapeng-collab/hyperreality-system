import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workloomProductVite } from "../../scripts/vite-product.mjs";

const server = `http://localhost:${Number(process.env.SERVER_PORT ?? 8787)}`;
const product = workloomProductVite("B 端移动工作台");

export default defineConfig({
  base: "./",
  define: product.define,
  plugins: [product.plugin, react()],
  server: {
    port: Number(process.env.WEBB_PORT ?? 5175),
    proxy: { "/trpc": { target: server, changeOrigin: true }, "/health": { target: server, changeOrigin: true } },
  },
  preview: {
    port: Number(process.env.WEBB_PORT ?? 5175),
    proxy: { "/trpc": { target: server, changeOrigin: true }, "/health": { target: server, changeOrigin: true } },
  },
});
