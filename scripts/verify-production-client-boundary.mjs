#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const target = resolve(process.cwd(), process.argv[2] ?? "dist");
if (!existsSync(target)) {
  console.error(`❌ 生产客户端文案门禁找不到构建目录：${target}`);
  process.exit(1);
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// 这些内容只允许出现在本地开发引导。正式客户端后端不可用时必须使用稳定中文
// 故障页，不能向普通访客释放本机端口、进程拓扑或仓库启动命令。
const forbidden = [
  "localhost:8787",
  "server:8787",
  "web:5173",
  "Docker PG",
  "pnpm preview:all",
  "pnpm setup",
  "pnpm dev",
  "本地开发验证码",
  "当前为开发验证通道",
];
const inspected = files(target).filter((path) => [".html", ".js", ".mjs"].includes(extname(path)));
const findings = [];
for (const path of inspected) {
  const source = readFileSync(path, "utf8");
  for (const text of forbidden) {
    if (source.includes(text)) findings.push(`${path}：${text}`);
  }
}

if (findings.length > 0) {
  console.error("❌ 生产客户端包含仅限开发环境的内部说明");
  for (const finding of findings) console.error(`  · ${finding}`);
  process.exit(1);
}
console.log(`✅ 生产客户端文案边界通过（检查 ${inspected.length} 个构建文件）`);
