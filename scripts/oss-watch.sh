#!/usr/bin/env bash
# oss-watch · 开源组件升级监测扫描器（只读，不改依赖）
# 用法：
#   bash scripts/oss-watch.sh          # 扫描到期组件 → 生成 docs/oss-update-plan.md
#   bash scripts/oss-watch.sh --all    # 忽略周期，全量扫描
#   bash scripts/oss-watch.sh --show   # 只显示当前计划（等价 pnpm oss:plan）
# 退出码：0=全部最新 / 2=有可用更新（提醒，非错误） / 1=执行错误
set -uo pipefail
cd "$(dirname "$0")/.."

MANIFEST="oss-components.json"
STATE=".oss-watch-state.json"
PLAN="docs/oss-update-plan.md"
MODE="${1:-}"
NPM_REGISTRY="https://registry.npmmirror.com"

if [ "$MODE" = "--show" ]; then
  [ -f "$PLAN" ] && cat "$PLAN" || echo "（尚无更新计划，先跑 pnpm oss:watch）"
  exit 0
fi

[ -f "$STATE" ] || echo '{}' > "$STATE"
mkdir -p docs

python3 - "$MANIFEST" "$STATE" "$PLAN" "$MODE" "$NPM_REGISTRY" <<'PYEOF'
import json, subprocess, sys, time, urllib.request, re

manifest_path, state_path, plan_path, mode, registry = sys.argv[1:6]
manifest = json.load(open(manifest_path))
state = json.load(open(state_path))
now = time.time()
CADENCE = {"weekly": 7*86400, "monthly": 30*86400, "event": 9999*86400}

def npm_latest(name):
    try:
        url = f"{registry}/{name.replace('/', '%2f')}"
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.npm.install-v1+json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
        return d.get("dist-tags", {}).get("latest")
    except Exception:
        return None

def gh_latest(repo_url, tag_prefix=""):
    m = re.search(r"github\.com[/:]([^/]+/[^/]+?)(?:\.git)?(?:（|/|$)", repo_url)
    if not m: return None
    repo = m.group(1)
    try:
        out = subprocess.run(["git", "ls-remote", "--tags", f"https://ghfast.top/https://github.com/{repo}"],
                             capture_output=True, text=True, timeout=30).stdout
        tags = [l.split("refs/tags/")[-1] for l in out.splitlines() if "refs/tags/" in l and "^{}" not in l]
        # 多命名空间仓库（如 tauri 的 tauri-v2.x 与 v1.x）按 tag_prefix 收敛
        if tag_prefix:
            tags = [t[len(tag_prefix):] for t in tags if t.startswith(tag_prefix)]
        # 只取纯版本号 tag，按 semver 排序
        ver = [t for t in tags if re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?", t)]
        if not ver: return None
        def key(t):
            parts = re.split(r"[.-]", t.lstrip("v"))
            return [int(p) if p.isdigit() else 0 for p in parts] + [0]*(4-len(parts))
        return sorted(ver, key=key)[-1]
    except Exception:
        return None

rows, due_count, skip_count = [], 0, 0
for c in manifest["components"]:
    name, cadence = c["name"], c.get("cadence", "monthly")
    last = state.get(name, {}).get("last_scan", 0)
    if mode != "--all" and now - last < CADENCE.get(cadence, 30*86400):
        skip_count += 1
        continue
    due_count += 1
    latest = None
    if c["channel"] == "npm":
        latest = npm_latest(name)
    elif c["channel"] == "github":
        latest = gh_latest(c["repo"], c.get("tag_prefix", ""))
    state[name] = {"last_scan": now, "latest_seen": latest or state.get(name, {}).get("latest_seen")}
    cur = c.get("current", "")
    if latest and cur and cur != latest and not cur.startswith("（") and "选型" not in cur and "观察" not in cur:
        rows.append(("UPDATE", name, cur, latest, cadence, c["gate"], c.get("notes", "")))
    elif latest:
        rows.append(("OK", name, cur or "—", latest, cadence, c["gate"], ""))
    else:
        rows.append(("SKIP", name, cur or "—", "（channel=" + c["channel"] + " 人工复核）", cadence, c["gate"], ""))

updates = [r for r in rows if r[0] == "UPDATE"]
W = time.strftime("%Y-%m-%d %H:%M")
L = []
L.append(f"# 开源组件更新计划（oss-watch）")
L.append("")
L.append(f"> 生成：{W} ｜ 本周期扫描 {due_count} 个组件（按周期跳过 {skip_count} 个未到期）｜ 有更新 **{len(updates)}** 个")
L.append(f"> 使用：人工圈定范围 → Agent 逐项升级 → 按 gate 过门禁 → 全绿后发布。**升级永不自动。**")
L.append("")
if updates:
    L.append("## 一、可用更新（待人工圈定）")
    L.append("")
    L.append("| 组件 | 现版 | 最新 | 周期 | 门禁 | 备注 |")
    L.append("|---|---|---|---|---|---|")
    for _, n, cur, lat, cad, gate, notes in updates:
        L.append(f"| `{n}` | {cur} | **{lat}** | {cad} | {gate} | {notes[:60]} |")
    L.append("")
    L.append("## 二、执行剧本（逐项）")
    L.append("")
    L.append("1. 每项单独 commit：`pnpm update <pkg>@<latest>` → 更新 oss-components.json 的 current")
    L.append("2. 门禁：smoke=`pnpm -r typecheck`｜standard=+`pnpm test`｜full=+全场景套件｜runtime-gate=+dsh-gate E6")
    L.append("3. 失败立即回滚该批并在本文件标「⛔ 阻塞」；全绿 → push 并标「✅ 已发布(hash)」")
    L.append("4. dsh 永远单独一批；IM 试点全绿后其余三仓同版跟升")
else:
    L.append("## 本周期全部到期组件均为最新 ✅")
    L.append("")
oks = [r for r in rows if r[0] == "OK"]
if oks:
    L.append("## 附：本周期已核对为最新")
    L.append("")
    L.append("| 组件 | 现版 | 上游最新 |")
    L.append("|---|---|---|")
    for _, n, cur, lat, *_ in oks:
        L.append(f"| `{n}` | {cur} | {lat} |")
skips = [r for r in rows if r[0] == "SKIP"]
if skips:
    L.append("")
    L.append("## 附：人工复核项（docker/skill/选型在案组件）")
    L.append("")
    for _, n, cur, lat, *_ in skips:
        L.append(f"- `{n}`：{cur}")
L.append("")
open(plan_path, "w").write("\n".join(L))
json.dump(state, open(state_path, "w"), indent=1)

print(f"[oss-watch] 扫描 {due_count}（跳过未到期 {skip_count}）→ 更新 {len(updates)} 个")
for r in updates:
    print(f"  UPDATE {r[1]}: {r[2]} → {r[3]}")
print(f"[oss-watch] 计划已写入 {plan_path}")
sys.exit(2 if updates else 0)
PYEOF
