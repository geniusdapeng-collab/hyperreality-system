#!/usr/bin/env node
/**
 * 公共产品运行身份解析器。
 *
 * 基座脚本、桌面打包和本地编排只能从受保护的 product.manifest.json 读取
 * 产品名、仓库与端口偏移；禁止把 workloom-im 或任一行业名称写死在公共能力中。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function gitRoot(start) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(start);
  }
}

export function loadProductRuntime(start = resolve(HERE, "..")) {
  const repositoryRoot = gitRoot(start);
  const manifestPath = join(repositoryRoot, "product.manifest.json");
  if (!existsSync(manifestPath)) throw new Error("缺少受保护的 product.manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("product.manifest.json 无法解析");
  }
  const productId = manifest?.productId;
  const displayName = manifest?.displayName;
  const repository = manifest?.repository;
  const demoWorkspaceSlug = manifest?.demoWorkspaceSlug;
  const demoMemberNo = manifest?.demoMemberNo;
  const portOffset = manifest?.desktop?.portOffset;
  if (typeof productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(productId)) {
    throw new Error("product.manifest.json 缺少有效产品标识");
  }
  if (
    typeof displayName !== "string"
    || displayName.trim() !== displayName
    || displayName.length < 2
    || displayName.length > 80
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new Error("product.manifest.json 缺少有效产品名称");
  }
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("product.manifest.json 缺少有效 GitHub 仓库");
  }
  if (typeof demoWorkspaceSlug !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(demoWorkspaceSlug)) {
    throw new Error("product.manifest.json 缺少有效演示工作区标识");
  }
  if (typeof demoMemberNo !== "string" || !/^[A-Z][A-Z0-9-]{1,31}$/.test(demoMemberNo)) {
    throw new Error("product.manifest.json 缺少有效演示成员编号");
  }
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 900) {
    throw new Error("product.manifest.json 的桌面端口偏移必须是 0 到 900 的整数");
  }
  return Object.freeze({
    repositoryRoot,
    manifestPath,
    productId,
    displayName,
    repository,
    demoWorkspaceSlug,
    demoMemberNo,
    portOffset,
    serverPort: 8787 + portOffset,
    webPort: 5173 + portOffset,
    pgPort: 5432 + portOffset,
    natsPort: 4222 + portOffset,
  });
}

function main() {
  const fieldIndex = process.argv.indexOf("--field");
  const field = fieldIndex >= 0 ? process.argv[fieldIndex + 1] : null;
  const product = loadProductRuntime();
  if (!field || !Object.hasOwn(product, field) || field === "repositoryRoot" || field === "manifestPath") {
    throw new Error("用法：node scripts/product-runtime.mjs --field productId|displayName|repository|demoWorkspaceSlug|demoMemberNo|portOffset|serverPort|webPort|pgPort|natsPort");
  }
  process.stdout.write(`${product[field]}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
