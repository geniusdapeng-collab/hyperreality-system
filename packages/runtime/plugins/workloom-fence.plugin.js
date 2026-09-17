// workloom-fence · dsh 插件挂载点（B8/D12；B0 hello-fence 的正式版）
// 形态：Cordis 函数插件，挂 tools/pre-execute 瀑布 → 转发 WorkLoom fence-engine 判定
// 挂载方式（profile cordis.patch.yml）：
//   - insert:
//       - id: workloom-fence
//         name: '@workloom/runtime/plugins/workloom-fence.plugin.js'
//         config:
//           rulesUrl: 'http://localhost:8787/trpc/fence.activeRules'   # 生效规则拉取端
// 判定语义（与围栏包头部口径一致）：block > review > auto；求值异常按 block（E2.1）；
// 未声明 fence_bindings 的调用方禁写（F2.10）由网关段①复查，此处只管瀑布判定。

export const name = 'workloom-fence'

const LEVEL_RANK = { auto: 0, review: 1, block: 2 }

export function apply(ctx, config = {}) {
  let cachedRules = null
  let cachedAt = 0

  async function activeRules() {
    // 10s 缓存（演示口径；生产经 dsh 事件失效）
    if (cachedRules && Date.now() - cachedAt < 10_000) return cachedRules
    if (!config.rulesUrl) return []
    const res = await fetch(config.rulesUrl)
    cachedRules = await res.json()
    cachedAt = Date.now()
    return cachedRules
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name ?? exec?.tool?.name ?? ''
    const rules = await activeRules()
    // 简化判定：规则 actions 命中工具名前缀（完整 DSL 求值在 fence-engine 服务侧，B8 接线）
    let level = 'auto'
    for (const r of rules) {
      const actions = r?.match?.actions ?? r?.actions ?? []
      if (actions.some((a) => toolName.startsWith(a.split('.')[0]))) {
        if (LEVEL_RANK[r.level] > LEVEL_RANK[level]) level = r.level
      }
    }
    console.log(`[workloom-fence] judge tool=${toolName} level=${level}（deny 优先并集 E2.2）`)
    if (level === 'block') return { kind: 'deny', reason: 'WorkLoom 围栏熔断（E2.2 deny 优先）' }
    if (level === 'review') return { kind: 'ask', reason: 'WorkLoom 围栏挂起必审（F2.1）' }
    return next()
  })
  console.log('[workloom-fence] mounted · 围栏瀑布已挂入 dsh 工具执行流水线')
}
