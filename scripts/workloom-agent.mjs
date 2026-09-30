#!/usr/bin/env node
/** Portable JSON CLI for the reviewed WorkLoom capability catalog. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CapabilityError, invokeCapability, loadCatalog, sanitizeErrorMessage } from "./agent-capabilities.mjs";

function parseArgs(argv) {
  const command = argv[0];
  const id = command === "list" ? undefined : argv[1];
  const rest = argv.slice(command === "list" ? 1 : 2);
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!["--bundle", "--base-url", "--input-file", "--root"].includes(flag) || !rest[i + 1]) {
      throw new CapabilityError("USAGE", "未知或不完整参数：" + flag, 2);
    }
    if (options[flag] !== undefined) throw new CapabilityError("USAGE", "重复参数：" + flag, 2);
    options[flag] = rest[++i];
  }
  if (!["list", "describe", "invoke"].includes(command)
      || (command !== "list" && (!id || id.startsWith("--")))) {
    throw new CapabilityError(
      "USAGE",
      "用法：node scripts/workloom-agent.mjs list|describe <id>|invoke <id> [--input-file <JSON文件或->] [--bundle <id>] [--base-url <URL>]",
      2,
    );
  }
  return { command, id, options };
}

async function readInput(file) {
  if (!file) return {};
  let source;
  try {
    if (file === "-") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      source = Buffer.concat(chunks).toString("utf8");
    } else {
      source = await readFile(file, "utf8");
    }
  } catch (error) {
    throw new CapabilityError("INPUT_READ_FAILED", "无法读取输入文件：" + error.message, 2);
  }
  try { return JSON.parse(source); }
  catch { throw new CapabilityError("INVALID_INPUT", "输入文件不是合法 JSON", 2); }
}

async function main() {
  const { command, id, options } = parseArgs(process.argv.slice(2));
  const root = options["--root"] ? resolve(options["--root"]) : resolve(import.meta.dirname, "..");
  const catalog = await loadCatalog(root, options["--bundle"]);
  let output;
  if (command === "list") {
    output = {
      schemaVersion: "workloom.agent-capability-list/v1",
      productId: catalog.product.productId,
      bundleId: catalog.bundle,
      capabilities: [...catalog.entries.values()].map((item) => ({
        id: item.id, version: item.version, title: item.title, description: item.description,
        operation: item.operation, risk: item.risk, dataMode: item.dataMode,
        enabled: item.enabled !== false,
        ...(item.enabled === false ? { disabledReason: item.disabledReason } : {}),
      })),
    };
  } else if (command === "describe") {
    output = catalog.entries.get(id);
    if (!output) throw new CapabilityError("NOT_FOUND", "能力不存在：" + id, 2);
  } else {
    const input = await readInput(options["--input-file"]);
    output = await invokeCapability(catalog, id, input, { baseUrl: options["--base-url"] });
  }
  process.stdout.write(JSON.stringify(output) + "\n");
}

try {
  await main();
} catch (error) {
  const code = error instanceof CapabilityError ? error.code : "INTERNAL_ERROR";
  const message = sanitizeErrorMessage(error);
  process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n");
  process.exitCode = error instanceof CapabilityError ? error.exitCode : 1;
}
