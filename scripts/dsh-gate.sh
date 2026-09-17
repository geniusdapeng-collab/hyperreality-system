#!/usr/bin/env bash
# E6 · dsh headless 回归门禁（D13①；H-5 kill -9 重放验收载体）
# 链路：Mock LLM（OpenAI 兼容，D4）→ dsh --profile headless 最小任务 → 工具调用过围栏瀑布
#      （workloom-fence 挂 tools/pre-execute）→ session/event 经事件桥落哈希链审计（workloom-audit）
#      → 验链 → kill -9 崩溃现场 → 链完整可验 + 重放零重复事件（H-5）
# 用法：bash scripts/dsh-gate.sh（失败即非零退出，纳入回归套件；E5 打 tag 前必跑）
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
GATE="$REPO/packages/runtime/dsh-gate"
export DSH_HOME="$REPO/.dsh-home"
export WORKLOOM_MOCK_KEY="gate-mock-key"   # Mock provider 不校验，凭据引用口径（L7.3）
AUDIT="$GATE/out/audit.jsonl"
MOCK_PORT=8799

step() { printf "\n▸ %s\n" "$1"; }
fail() { printf "❌ %s\n" "$1" >&2; exit 1; }

step "0. 准备：锁版 dsh 依赖 + node-pty 原生模块"
cd "$GATE"
[ -d node_modules ] || pnpm install --ignore-workspace
# node-pty 仅当依赖图里存在时才需要预构建（dsh ≥0.1.1-rc.2 已移除该依赖）；
# find 目录不存在时返回非零，须 || true 兜底（set -euo pipefail 下防静默中止）
if [ -d node_modules/.pnpm ] && ls node_modules/.pnpm 2>/dev/null | grep -q "^node-pty@"; then
  PTY=$(find node_modules/.pnpm -path "*linux-x64*pty.node" -o -path "*darwin-*pty.node" 2>/dev/null | head -1 || true)
  [ -n "$PTY" ] || pnpm rebuild node-pty --ignore-workspace >/dev/null 2>&1 || fail "node-pty 构建失败（需 Xcode CLT / build-essential）"
fi
mkdir -p out
rm -f "$AUDIT"
DSH="$GATE/node_modules/.bin/dsh"

step "1. 初始化 headless profile + 写入 Mock provider 设置"
# 首次 boot 自动从模板初始化 profile（dsh 官方行为）；--dump-config 不启动会话，仅用于触发初始化
[ -f "$DSH_HOME/profiles/headless/package.json" ] || DSH_HOME="$DSH_HOME" "$DSH" --profile headless --dump-config >/dev/null 2>&1 || true
[ -f "$DSH_HOME/profiles/headless/package.json" ] || fail "headless profile 初始化失败"
sed -e "s|__REPO_ROOT__|$REPO|g" -e "s|__AUDIT_FILE__|$AUDIT|g" \
  "$GATE/profile.cordis.patch.yml" > "$DSH_HOME/profiles/headless/cordis.patch.yml"
cp "$GATE/settings.yaml" "$DSH_HOME/settings.yaml"
echo "✅ profile patch 与 settings.yaml 落位（provider=workloom-mock → 127.0.0.1:${MOCK_PORT}）"

step "2. 起 Mock LLM（OpenAI 兼容 + 围栏规则源）"
MOCK_LLM_PORT=$MOCK_PORT node "$GATE/mock-openai.mjs" > "$GATE/out/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$MOCK_PORT/rules" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$MOCK_PORT/rules" >/dev/null || fail "Mock LLM 未就绪"

step "3. 用例一：最小任务全链（headless → 工具调用 → 围栏瀑布 → 事件落账）"
DSH_HOME="$DSH_HOME" "$DSH" --profile headless "最小任务：执行 bash echo 并汇报结果" > "$GATE/out/run1.log" 2>&1 || {
  tail -20 "$GATE/out/run1.log"; fail "headless 用例一退出非零"
}
grep -q "TASK_COMPLETE" "$GATE/out/run1.log" || { tail -20 "$GATE/out/run1.log"; fail "未打印最终答案（TASK_COMPLETE）"; }
echo "✅ headless 打印最终答案并退出"
grep -q "\[workloom-fence\] mounted" "$GATE/out/run1.log" || fail "围栏插件未挂载"
grep -q "\[workloom-fence\] judge tool=.*level=" "$GATE/out/run1.log" || fail "工具调用未过围栏瀑布（tools/pre-execute）"
echo "✅ 工具调用经围栏瀑布判定（deny 优先并集 E2.2）"
grep -q "\[workloom-audit\] mounted" "$GATE/out/run1.log" || fail "事件桥插件未挂载"
sleep 1  # 事件落账 flush
[ -s "$AUDIT" ] || fail "事件桥未落账（session/event 未到达）"
node "$GATE/verify-audit.mjs" "$AUDIT" || fail "审计链验证失败"
echo "✅ 事件落账 + 哈希链验证通过（G8 同构：模型可见即已记录）"

step "4. 用例二（H-5）：kill -9 崩溃现场 → 链完整 + 重放零重复"
AUDIT2="$GATE/out/audit-kill.jsonl"
rm -f "$AUDIT2"
sed -e "s|__REPO_ROOT__|$REPO|g" -e "s|__AUDIT_FILE__|$AUDIT2|g" \
  "$GATE/profile.cordis.patch.yml" > "$DSH_HOME/profiles/headless/cordis.patch.yml"
kill $MOCK_PID 2>/dev/null || true; sleep 0.5   # 换慢速 Mock（同端口，先释放）
DSH_SLOW_MS=1500 MOCK_LLM_PORT=$MOCK_PORT node "$GATE/mock-openai.mjs" > "$GATE/out/mock2.log" 2>&1 &
MOCK2_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$MOCK_PORT/rules" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$MOCK_PORT/rules" >/dev/null || fail "慢速 Mock LLM 未就绪"
DSH_HOME="$DSH_HOME" "$DSH" --profile headless "慢任务：执行 bash echo 后缓慢汇报" > "$GATE/out/run2.log" 2>&1 &
DSH_PID=$!
# 等事件桥开始落账（工具调用已发生），随后 kill -9 制造崩溃现场
for i in $(seq 1 60); do [ -s "$AUDIT2" ] && break; sleep 0.25; done
[ -s "$AUDIT2" ] || { kill $DSH_PID $MOCK2_PID 2>/dev/null; fail "慢任务未产生事件，无法制造崩溃现场"; }
sleep 2  # 落在最终答案的缓慢流式段中途
kill -9 $DSH_PID 2>/dev/null || true
sleep 1
grep -q "TASK_COMPLETE" "$GATE/out/run2.log" && { cat "$GATE/out/run2.log"; fail "kill -9 过晚：任务已完成，非崩溃现场"; }
echo "✅ 已 kill -9（pid ${DSH_PID}），dsh 进程崩溃于推理流中途（run2 无最终答案，确为崩溃现场）"
node "$GATE/verify-audit.mjs" "$AUDIT2" --replay "$DSH_HOME/sessions" || fail "崩溃现场链验证/重放幂等失败"
echo "✅ H-5：kill -9 后审计链完整可验、会话事件重放零重复（幂等）"
kill $MOCK2_PID 2>/dev/null || true

step "5. 汇总"
echo "✅ E6 dsh headless 回归门禁全绿（用例一全链 + 用例二 H-5 崩溃重放）"
