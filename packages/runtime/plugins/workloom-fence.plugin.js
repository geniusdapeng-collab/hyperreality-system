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
// 规则源（MC-105 修复）：rulesFile（离线/无鉴权，优先）或 rulesUrl（tRPC `fence.activeRules`）；
// 两种源都不可用/响应不是数组时 **fail-closed（deny）**——绝不放行（E2.1），也不再把错误体当数组。

import { readFileSync } from 'node:fs'

export const name = 'workloom-fence'

const LEVEL_RANK = { auto: 0, review: 1, block: 2 }

export function apply(ctx, config = {}) {
  let cachedRules = null
  let cachedAt = 0

  /**
   * 返回规则数组；规则源不可用时返回 null（调用方按 fail-closed 拒绝执行）。
   * 10s 缓存（演示口径；生产经 dsh 事件失效）。
   */
  async function activeRules() {
    if (cachedRules && Date.now() - cachedAt < 10_000) return cachedRules
    let rules = null
    if (config.rulesFile) {
      try {
        rules = JSON.parse(readFileSync(config.rulesFile, 'utf8'))
      } catch (error) {
        console.error(`[workloom-fence] rulesFile 读取失败：${error?.message ?? error}`)
        return null
      }
    } else if (config.rulesUrl) {
      try {
        const headers = config.rulesToken ? { authorization: `Bearer ${config.rulesToken}` } : undefined
        const res = await fetch(config.rulesUrl, { headers })
        const body = await res.json()
        // tRPC 信封（{result:{data}}）或裸数组都接受；错误体（404 No procedure found 等）不是数组 → null
        rules = Array.isArray(body) ? body : body?.result?.data ?? null
      } catch (error) {
        console.error(`[workloom-fence] rulesUrl 拉取失败：${error?.message ?? error}`)
        return null
      }
    }
    if (!Array.isArray(rules)) {
      console.error('[workloom-fence] 规则源不可用或返回非数组：按 E2.1 fail-closed')
      return null
    }
    cachedRules = rules
    cachedAt = Date.now()
    return cachedRules
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name ?? exec?.tool?.name ?? ''
    const rules = await activeRules()
    if (rules === null) {
      // 规则源缺失/损坏时不得静默放行：与 fence-engine 求值异常同口径（宁可错杀 E2.1）
      return { kind: 'deny', reason: 'WorkLoom 围栏规则源不可用（fail-closed，E2.1）' }
    }
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
