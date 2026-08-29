#!/usr/bin/env node
/**
 * hardcode-scan —— 硬编码候选扫描器（六类维度，五仓通用）
 * 用法：node scripts/hardcode-scan.mjs [repoRoot] [--json]
 * 产出：候选清单（含白名单自动标注），供语义复核层逐条判定
 * 纪律：本脚本只产出"候选"，不做最终判定；白名单命中≠无问题，仅降低优先级
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? ".");
const AS_JSON = process.argv.includes("--json");
if (!existsSync(ROOT)) { console.error(`目录不存在：${ROOT}`); process.exit(1); }

/** 六类维度扫描规则：{ id, 类别, 模式(grep -E), pathPrefix(路径前缀过滤), note } */
const RULES = [
  // A 环境配置类
  { id: "A1", cat: "A-环境配置", re: "postgres(ql)?://[^\"'\\s]+", note: "数据库连接串字面量" },
  { id: "A2", cat: "A-环境配置", re: "(localhost|127\\.0\\.0\\.1):[0-9]{2,5}", note: "host:port 字面量" },
  { id: "A3", cat: "A-环境配置", re: "https?://[a-z0-9.-]+\\.[a-z]{2,}", note: "写死 URL（前端/服务端）" },
  { id: "A4", cat: "A-环境配置", re: "(/root/|/Users/|/home/)[a-zA-Z0-9_.-]+", note: "绝对路径" },
  // B 身份与演示数据类（生产路径写死业务身份）
  { id: "B1", cat: "B-身份演示", re: "(panda-group|ws-yunqi|ws-hotel|yunqi-hotel|ws-video|ws-geo)", note: "写死工作区 slug/id" },
  { id: "B2", cat: "B-身份演示", re: "MEM-00[0-9]", note: "写死成员号" },
  { id: "B3", cat: "B-身份演示", re: "(demo|演示).{0,12}(账号|密码|口令)", note: "演示账号口令" },
  // C 密钥凭据类
  { id: "C1", cat: "C-密钥凭据", re: "(secret|token|apikey|api_key|password|passwd)\\s*[:=]\\s*[\"'][^\"']{6,}[\"']", note: "疑似密钥字面量" },
  { id: "C2", cat: "C-密钥凭据", re: "ghp_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9]{20,}|AKID[a-zA-Z0-9]{20,}", note: "真实格式密钥（P0）" },
  // D 行业语义泄漏类（底座包不应出现行业词；按仓注入行业词表）
  { id: "D1", cat: "D-行业泄漏", re: "HARDWORDS_BASE", pathPrefix: "packages/(base|runtime|shared|db|connectors)/", note: "底座包含行业词" },
  // E 业务规则外溢类
  { id: "E1", cat: "E-规则外溢", re: "(阈值|红线|宽限|threshold).{0,30}[0-9]+(\\.[0-9]+)?|[0-9]+(\\.[0-9]+)?\\s*(%|pp)\\b", pathPrefix: "apps/", note: "应用层阈值字面量" },
  { id: "E2", cat: "E-规则外溢", re: "(cap|limit|max|min)[:=]\\s*[0-9]{3,}", pathPrefix: "packages/", note: "额度/上限默认值（检查是否行业适配）" },
  // F 文案展示类
  { id: "F1", cat: "F-文案展示", re: ">[A-Z][A-Za-z ]{3,30}<", pathPrefix: "apps/(web|webc)/src/", note: "JSX 直出英文文案" },
  { id: "F2", cat: "F-文案展示", re: "(stable|launch|growth|burst|decline|clearance|promo_prep|promo_peak|owner|manager|readonly)\\b", pathPrefix: "apps/(web|webc)/src/", note: "枚举直显（应走 display 字典）" },
];

/** 白名单：路径命中即标注豁免（仍输出，优先级降低） */
const WHITELIST = [
  /(^|\/)(node_modules|\.git|vendor|dist|\.turbo)\//,
  /\.(test|spec)\.(ts|tsx|mjs|js)$/, /suite\.ts$/, /e2e.*\.(ts|mjs)$/,
  /(^|\/)scripts\/(seed|seed-[^/]*|simulate-twin|audit-scan)\.ts$/,
  /(^|\/)docs\//, /(^|\/)mock\//, /(^|\/)demo\//, /\.md$/,
  /(^|\/)packages\/db\/migrations\//,
  /\.env\.example$/, /(^|\/)README[^/]*$/,
  /smoke\.ts$/, /hardcode-scan\.mjs$/, /display\.ts$/,
  /(^|\/)scripts\/(generate-capabilities|verify-chain|snapshot-twin|restore-twin)/,
];
/** 白名单：内容命中即豁免 */
const WHITELIST_CONTENT = [
  /process\.env\./, /process\.env\[/, // 读 env 的兜底默认值属可接受（复核时再定级）
];

/** 各行业词表（D1 用）：底座不该出现的词；按仓名注入 */
const INDUSTRY_WORDS = {
  "panda-ecom-build": "酒店|客房|入住|夜审|布草|云栖|美团(?!网)|hotel(?!ier)|roomType|checkin",
  "workloom-hotel": "电商|拼多多|亚马逊|抖音|千川|ACoS|SKU|listing",
  "hyperreality-system": "电商|拼多多|亚马逊|酒店|客房|入住|夜审|OCC|保底价",
  "workloom": "拼多多|亚马逊|千川|ACoS(?!\\w)",
  "workloom-im": "酒店|客房|入住|夜审|布草|电商|拼多多|亚马逊|抖音|小红书|SKU|listing|ACoS|社媒|涨粉",
};

function grepAll(pattern) {
  try {
    const out = execSync(
      `grep -rEn --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.sh' --include='*.json' --include='*.yml' --include='*.yaml' -- '${pattern.replaceAll("'", "'\\''")}' . 2>/dev/null | head -300`,
      { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch { return []; }
}

const repoName = ROOT.split("/").pop();
const hardWords = INDUSTRY_WORDS[repoName];
const findings = [];

for (const rule of RULES) {
  if (rule.re === "HARDWORDS_BASE") {
    if (!hardWords) continue;
    rule.re = hardWords;
  }
  const lines = grepAll(rule.re);
  const prefixRe = rule.pathPrefix ? new RegExp(rule.pathPrefix) : null;
  for (const line of lines) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, ln, content] = m;
    if (prefixRe && !prefixRe.test(file)) continue;
    const exemptPath = WHITELIST.some((w) => w.test(file));
    const exemptContent = WHITELIST_CONTENT.some((w) => w.test(content));
    findings.push({
      rule: rule.id, cat: rule.cat, file, line: Number(ln),
      content: content.trim().slice(0, 160),
      note: rule.note, exempt: exemptPath || exemptContent,
    });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(findings, null, 1));
} else {
  const byCat = {};
  for (const f of findings) {
    byCat[f.cat] ??= { total: 0, suspect: 0 };
    byCat[f.cat].total++;
    if (!f.exempt) byCat[f.cat].suspect++;
  }
  console.log(`# 硬编码候选扫描：${repoName}\n`);
  console.log("| 类别 | 候选总数 | 疑似（非白名单） |");
  console.log("|---|---|---|");
  for (const [cat, v] of Object.entries(byCat)) console.log(`| ${cat} | ${v.total} | ${v.suspect} |`);
  console.log(`\n合计 ${findings.length} 条候选，其中疑似 ${findings.filter((f) => !f.exempt).length} 条待复核\n`);
  for (const f of findings.filter((x) => !x.exempt)) {
    console.log(`[${f.rule}] ${f.file}:${f.line}  ${f.content.slice(0, 110)}  （${f.note}）`);
  }
}
