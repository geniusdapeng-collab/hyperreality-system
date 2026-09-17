/**
 * skill-forge · 第三方组件技能化集成工具链（每个项目自带的基础能力）
 *
 * 配套元技能《第三方组件技能化集成方法论》（skills/official/component-integration/）：
 * 把 SOP 的每一步变成可执行命令——任何项目克隆即可用，不依赖官方运营台。
 *
 * 用法：
 *   pnpm skill:forge evaluate <github-url> [--license MIT] [--cloud none|optional|required]
 *       五维评估（许可证/云依赖/架构契合/供应链/活跃度）→ 结论 + 建议定级 + dist.json 草稿
 *   pnpm skill:forge check <dir>
 *       校验技能资产（SKILL.md frontmatter + dist.json）并跑 staging 同款预检③④⑤（不签名）
 *   pnpm skill:forge package <dir> [--key <hex>]
 *       check 通过后官方签名（HMAC-SHA256）→ 输出分发包 JSON（<dir>/dist.package.json）
 *   pnpm skill:forge register <dir> --name <组件名> --repo <url> [--gate smoke|standard|full]
 *       登记 oss-components.json（进 oss-watch 周期监控）
 *   pnpm skill:forge publish <dir> [--out <manifest.json>] [--key <hex>]
 *       package + 追加进本地 registry manifest（官方运营台直接对外服务此文件即可）
 *
 * 环境：签名密钥取 SKILL_DIST_SIGNING_KEY 或 --key；GitHub 元数据直连失败时自动走 ghfast 镜像，
 *      仍失败则退化为人人可填的 --license/--cloud 手工评估（不阻塞流程）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanSkillForInjection, scanSkillForPublish, parseSkillFrontmatter } from "@workloom/base/skills";
import { DistMeta, signPackage, classifyTier, type SkillPackage } from "@workloom/base/skill-ops";

const ROOT = new URL("..", import.meta.url).pathname;
const [, , cmd, ...rest] = process.argv;

const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i]!.startsWith("--")) flags[rest[i]!.slice(2)] = rest[++i]!;
  else positional.push(rest[i]!);
}

const say = (s = "") => console.log(s);
const fail = (s: string): never => { console.error(`✗ ${s}`); process.exit(1); };

/* ---------- evaluate：五维评估 ---------- */

interface RepoMeta { license: string; stars: number; pushedAt: string; description: string }

async function fetchRepoMeta(url: string): Promise<RepoMeta | null> {
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const api = `https://api.github.com/repos/${m[1]}/${m[2]}`;
  for (const u of [api, `https://ghfast.top/${api}`]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "skill-forge" } });
      if (!r.ok) continue;
      const j = await r.json() as { license?: { spdx_id?: string }; stargazers_count?: number; pushed_at?: string; description?: string };
      return {
        license: j.license?.spdx_id ?? "UNKNOWN",
        stars: j.stargazers_count ?? 0,
        pushedAt: j.pushed_at ?? "",
        description: j.description ?? "",
      };
    } catch { /* 尝试下一通道 */ }
  }
  return null;
}

function evaluateLicense(license: string): { pass: boolean; note: string } {
  const ok = ["MIT", "APACHE-2.0", "BSD-2-CLAUSE", "BSD-3-CLAUSE", "ISC"];
  const agpl = ["AGPL-3.0", "AGPL-3.0-ONLY", "AGPL-3.0-OR-LATER"];
  if (ok.includes(license.toUpperCase())) return { pass: true, note: `${license} 直接过` };
  if (agpl.includes(license.toUpperCase())) return { pass: true, note: `${license} 仅"独立进程调用"形态收录` };
  if (license === "UNKNOWN" || license === "NOASSERTION") return { pass: false, note: "许可证未知，需人工确认" };
  return { pass: false, note: `${license} 有商业限制风险，不建议收录` };
}

function evaluateActivity(pushedAt: string): { pass: boolean; note: string } {
  if (!pushedAt) return { pass: false, note: "活跃度未知（网络受限未取到，需人工确认）" };
  const days = (Date.now() - new Date(pushedAt).getTime()) / 864e5;
  if (days <= 90) return { pass: true, note: `近 90 天有提交（${Math.floor(days)} 天前）` };
  if (days <= 180) return { pass: true, note: `近半年有提交（${Math.floor(days)} 天前），尚可` };
  return { pass: false, note: `停更超 ${Math.floor(days)} 天，建议观察项不入运行时` };
}

async function cmdEvaluate(url: string) {
  say(`═══ skill-forge evaluate：${url} ═══\n`);
  const meta = await fetchRepoMeta(url);
  if (meta) say(`仓库元数据：license=${meta.license} · stars=${meta.stars} · 最近提交=${meta.pushedAt?.slice(0, 10)}\n  ${meta.description}\n`);
  else say(`⚠ 仓库元数据获取失败（网络受限），进入手工评估模式（--license/--cloud 可补全）\n`);

  const license = (flags.license ?? meta?.license ?? "UNKNOWN").toUpperCase();
  const cloud = flags.cloud ?? "unknown";
  const l = evaluateLicense(license);
  const a = evaluateActivity(meta?.pushedAt ?? "");
  const cloudNote = cloud === "none" ? "纯本地，最优"
    : cloud === "optional" ? "云依赖可拆（客户自配账号、API Key 本机）→ 可集成但须出站域全声明"
    : cloud === "required" ? "强制云依赖且不可拆 → 触碰数据主权红线，否决"
    : "云依赖情况未声明（--cloud none|optional|required 补全）";

  const rows: Array<[string, string, boolean | null]> = [
    ["许可证", l.note, l.pass],
    ["云依赖", cloudNote, cloud === "none" || cloud === "optional" ? true : cloud === "required" ? false : null],
    ["架构契合", "默认过关——适配时必须经工具白名单+围栏参数纳入治理面（适配纪律，非组件属性）", true],
    ["供应链", "登记 oss-components.json 进 oss-watch 周期监控（必做动作）", true],
    ["活跃度", a.note, a.pass],
  ];
  for (const [dim, note, pass] of rows) say(`  ${pass === true ? "✓" : pass === false ? "✗" : "?"} ${dim}：${note}`);

  const hardNo = rows.some(([, , p]) => p === false);
  const unknown = rows.some(([, , p]) => p === null);
  const suggestedTier = cloud === "none" ? "L2（tool-execution 本地执行面）或 L0（若纯知识）" : "L2（tool-execution · 云依赖显式治理，可选装配）";
  say(`\n结论：${hardNo ? "不建议集成（登记观察项）" : unknown ? `倾向集成（定级 ${suggestedTier}）——标记 ? 项需人工确认后定稿` : `建议集成——定级 ${suggestedTier}`}`);
  say(`\ndist.json 草稿：`);
  say(JSON.stringify({
    category: "tool-execution",
    origin: "oss-curated",
    deps: [],
    toolWhitelist: [],
    egressDomains: cloud === "none" ? [] : ["<填写出站域>"],
    fenceParams: { dailyActionCap: "<上限>", humanLoginOnly: true },
    license,
    sourceRepo: url.replace(/\.git$/, ""),
  }, null, 2));
}

/* ---------- check / package：资产校验 + staging 同款预检③④⑤ ---------- */

function loadSkillDir(dir: string): { body: string; meta: ReturnType<typeof DistMeta.parse>; name: string; version: string; description: string } {
  const skillFile = join(dir, "SKILL.md");
  const distFile = join(dir, "dist.json");
  if (!existsSync(skillFile)) fail(`${dir} 缺 SKILL.md`);
  if (!existsSync(distFile)) fail(`${dir} 缺 dist.json（评估产出见 skill:forge evaluate）`);
  const body = readFileSync(skillFile, "utf-8");
  const fm = parseSkillFrontmatter(body);
  if (!fm.name) fail("SKILL.md frontmatter 缺 name（残缺资产不静默放行）");
  const unquote = (s: string) => s.replace(/^"|"$/g, "");
  fm.version = unquote(fm.version);
  fm.description = unquote(fm.description);
  let meta;
  try {
    meta = DistMeta.parse(JSON.parse(readFileSync(distFile, "utf-8")));
  } catch (err) {
    fail(`dist.json 不合 DistMeta schema：${err instanceof Error ? err.message : err}`);
  }
  return { body, meta, name: fm.name, version: fm.version, description: fm.description };
}

function runChecks(dir: string, skillId?: string): { pkg: Omit<SkillPackage, "signature">; tier: string } {
  const { body, meta, name, version, description } = loadSkillDir(dir);
  const pii = scanSkillForPublish(body, description);
  if (pii.length) fail(`脱敏扫描命中（staging③）：${pii.map((h) => h.detail).join("；")}`);
  const inj = scanSkillForInjection(body);
  if (inj.length) fail(`注入对抗命中（staging④）：${inj.map((h) => h.detail).join("；")}`);
  const badDeps = meta.deps.filter((d) => !/^[a-z0-9@/_.-]+$/i.test(d));
  if (badDeps.length) fail(`依赖声明形态非法（staging②）：${badDeps.join("、")}`);
  const id = skillId ?? `skill-${name.replace(/\s+/g, "-").toLowerCase()}`;
  const pkg = { skillId: id, name, version, description, body, fenceBindings: [] as string[], meta };
  const { tier } = classifyTier({ ...pkg, signature: "0".repeat(64) }, null);
  return { pkg, tier };
}

/* ---------- 生态位重叠扫描（⓪业务准入·去重检查） ---------- */

interface ExistingSkill {
  id: string;
  name: string;
  description: string;
  category?: string;
  egressDomains: string[];
  toolWhitelist: string[];
}

/** 收集现有技能库（registry 分发技能 + official 自带技能）作为对照集 */
function collectExistingSkills(excludeDir: string): ExistingSkill[] {
  const out: ExistingSkill[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/");
  // registry（带 dist.json 的分发技能）
  const regDir = join(ROOT, "skills/registry");
  if (existsSync(regDir)) {
    for (const name of readdirSync(regDir)) {
      const d = join(regDir, name);
      if (norm(d) === norm(excludeDir)) continue;
      const dj = join(d, "dist.json");
      if (!existsSync(dj)) continue;
      try {
        const meta = DistMeta.parse(JSON.parse(readFileSync(dj, "utf-8")));
        const body = readFileSync(join(d, "SKILL.md"), "utf-8");
        const fm = parseSkillFrontmatter(body);
        out.push({
          id: name, name: fm.name ?? name, description: fm.description ?? "",
          category: meta.category, egressDomains: meta.egressDomains, toolWhitelist: meta.toolWhitelist,
        });
      } catch { /* 残缺资产不阻塞扫描 */ }
    }
  }
  // official（自带技能，只有 SKILL.md）
  const offDir = join(ROOT, "skills/official");
  if (existsSync(offDir)) {
    for (const suite of readdirSync(offDir)) {
      const sd = join(offDir, suite);
      if (!existsSync(sd)) continue;
      for (const skill of readdirSync(sd)) {
        const f = join(sd, skill, "SKILL.md");
        if (!existsSync(f)) continue;
        try {
          const fm = parseSkillFrontmatter(readFileSync(f, "utf-8"));
          out.push({ id: `official/${suite}/${skill}`, name: fm.name ?? skill, description: fm.description ?? "", egressDomains: [], toolWhitelist: [] });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

/** 关键词提取：英文按词、中文按 2-gram，去停用噪声 */
function keywordsOf(text: string): Set<string> {
  const set = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) set.add(w);
  const zh = text.replace(/[\x00-\xff]/g, "");
  for (let i = 0; i + 2 <= zh.length; i++) set.add(zh.slice(i, i + 2));
  return set;
}

/** 生态位重叠提示：同类别 / 出站域交集 / 工具面交集 / 描述关键词重合率 ≥40% */
function scanOverlap(dir: string, meta: ReturnType<typeof DistMeta.parse>, description: string, skillName: string): string[] {
  const warnings: string[] = [];
  const mine = keywordsOf(`${skillName} ${description}`);
  for (const ex of collectExistingSkills(dir)) {
    const reasons: string[] = [];
    if (meta.category && ex.category === meta.category && meta.category !== "knowledge") {
      reasons.push(`同为 ${meta.category} 类执行面技能`);
    }
    const egressHit = meta.egressDomains.filter((d) => ex.egressDomains.includes(d));
    if (egressHit.length) reasons.push(`出站域重合 [${egressHit.join(", ")}]`);
    const toolHit = meta.toolWhitelist.filter((t) => ex.toolWhitelist.includes(t));
    if (toolHit.length) reasons.push(`工具面重合 [${toolHit.join(", ")}]`);
    const theirs = keywordsOf(`${ex.name} ${ex.description}`);
    const inter = [...mine].filter((k) => theirs.has(k)).length;
    const ratio = mine.size && theirs.size ? inter / Math.min(mine.size, theirs.size) : 0;
    if (ratio >= 0.4) reasons.push(`描述关键词重合率 ${(ratio * 100).toFixed(0)}%`);
    if (reasons.length >= 2) {
      warnings.push(`与现有技能「${ex.name}」(${ex.id}) 疑似生态位重叠：${reasons.join("；")}`);
    }
  }
  return warnings;
}

function cmdCheck(dir: string, quiet = false) {
  const { pkg, tier } = runChecks(dir, flags["skill-id"]);
  const overlaps = scanOverlap(dir, pkg.meta, pkg.description, pkg.name);
  if (!quiet) {
    say(`✓ ${pkg.skillId} v${pkg.version}「${pkg.name}」`);
    say(`  类别=${pkg.meta.category} · 来源=${pkg.meta.origin} · 定级=${tier}（首装预判）`);
    say(`  依赖=[${pkg.meta.deps.join(", ")}] · 工具白名单=[${pkg.meta.toolWhitelist.join(", ")}] · 出站域=[${pkg.meta.egressDomains.join(", ")}]`);
    say(`  预检③④⑤ 全过（脱敏/注入/依赖形态与 staging 同函数）`);
  }
  if (overlaps.length) {
    say(`  ⚠ 生态位重叠提示（⓪业务准入审查项，评审人必须书面回答"现有技能为什么不够用"）：`);
    for (const w of overlaps) say(`    - ${w}`);
  } else if (!quiet) {
    say(`  生态位扫描：无重叠（对照 registry + official 全部现有技能）`);
  }
  return { pkg, tier };
}

function cmdPackage(dir: string) {
  const { pkg, tier } = cmdCheck(dir, true);
  const key = flags.key ?? process.env.SKILL_DIST_SIGNING_KEY ?? "";
  if (!key) fail("未配置签名密钥（--key 或 SKILL_DIST_SIGNING_KEY）");
  const signed: SkillPackage = { ...pkg, signature: signPackage(key, pkg) };
  const out = join(dir, "dist.package.json");
  writeFileSync(out, JSON.stringify(signed, null, 2) + "\n", "utf-8");
  say(`✓ 签名完成（HMAC-SHA256）→ ${out}`);
  say(`  ${signed.skillId} v${signed.version} · 定级=${tier} · 签名=${signed.signature.slice(0, 16)}…`);
  return signed;
}

/* ---------- register：登记 oss-components.json ---------- */

function cmdRegister(dir: string) {
  const name = flags.name ?? fail("缺 --name <组件名>");
  const repo = flags.repo ?? fail("缺 --repo <url>");
  const gate = flags.gate ?? "standard";
  const { meta } = loadSkillDir(dir);
  const file = join(ROOT, "oss-components.json");
  const data = JSON.parse(readFileSync(file, "utf-8")) as {
    meta: { updated: string };
    components: Array<Record<string, unknown> & { name: string }>;
  };
  if (data.components.some((c) => c.name === name)) {
    say(`· ${name} 已在 oss-components.json（跳过，幂等）`);
    return;
  }
  data.meta.updated = new Date().toISOString().slice(0, 10);
  data.components.push({
    name,
    repo,
    channel: "github",
    current: "选型入库（技能市场执行面技能）",
    cadence: "weekly",
    gate,
    scope: dir.replace(ROOT, "").replace(/^\//, ""),
    notes: `${meta.license}；${meta.egressDomains.length ? `出站 ${meta.egressDomains.join("/")} 全声明过三段瀑布` : "纯本地零出站"}；经 skill:forge 集成`,
  });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  say(`✓ ${name} 已登记 oss-components.json（gate=${gate}，oss-watch 周检）`);
}

/* ---------- publish：加入本地 registry manifest ---------- */

function cmdPublish(dir: string) {
  const signed = cmdPackage(dir);
  const out = flags.out ?? join(ROOT, "skills/registry/manifest.json");
  let manifest: { registryVersion: string; publishedAt: string; entries: unknown[] } = {
    registryVersion: "", publishedAt: "", entries: [],
  };
  if (existsSync(out)) manifest = JSON.parse(readFileSync(out, "utf-8"));
  const entries = (manifest.entries as Array<{ package: SkillPackage }>).filter((e) => e.package.skillId !== signed.skillId);
  entries.push({ targets: {}, package: signed });
  manifest.entries = entries;
  manifest.registryVersion = new Date().toISOString().slice(0, 10).replace(/-/g, ".") + ".1";
  manifest.publishedAt = new Date().toISOString();
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  say(`✓ 已加入本地 registry manifest（${out}，共 ${entries.length} 个技能）`);
  say(`  客户端配置 SKILL_DIST_REGISTRY_URL 指向此文件服务地址即可拉取`);
}

/* ---------- main ---------- */

const dir = positional[0] ? join(ROOT, positional[0]) : "";
switch (cmd) {
  case "evaluate": {
    const url = positional[0] ?? fail("用法：pnpm skill:forge evaluate <github-url>");
    await cmdEvaluate(url);
    break;
  }
  case "check": cmdCheck(dir || fail("用法：pnpm skill:forge check <技能目录>")); break;
  case "package": cmdPackage(dir || fail("用法：pnpm skill:forge package <技能目录>")); break;
  case "register": cmdRegister(dir || fail("用法：pnpm skill:forge register <技能目录> --name <名> --repo <url>")); break;
  case "publish": cmdPublish(dir || fail("用法：pnpm skill:forge publish <技能目录>")); break;
  default:
    say("skill-forge · 第三方组件技能化集成工具链\n");
    say("  evaluate <github-url>   五维评估 + dist.json 草稿");
    say("  check <dir>             资产校验 + staging 同款预检（不签名）");
    say("  package <dir>           官方签名 → dist.package.json");
    say("  register <dir>          登记 oss-components.json");
    say("  publish <dir>           签名并加入本地 registry manifest");
    if (cmd) process.exitCode = 1;
}
