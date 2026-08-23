import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// C 端（AI 服务前台）：proxy 转发 /c → server（契约 baseURL=/c，目标端口 SERVER_PORT ?? 8787）
const cProxy = {
  target: `http://localhost:${Number(process.env.SERVER_PORT ?? 8787)}`,
  changeOrigin: true,
};
export default defineConfig({
  base: "./", // 子路径托管（/app/c）下资源相对引用
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEBC_PORT ?? 5176),
    proxy: { "/c": cProxy },
  },
  preview: {
    port: Number(process.env.WEBC_PORT ?? 5176),
    proxy: { "/c": cProxy },
  },
});
