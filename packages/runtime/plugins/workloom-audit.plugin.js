// workloom-audit · dsh 事件桥原型（E6/D12：workdata → session/event seam 映射的最小实证）
// 形态：Cordis 函数插件，监听 session/event 事件流 → 哈希链审计日志（append-only jsonl）
// 哈希链口径与五元事件库同构：sha256(prev_hash ‖ canonical(payload))（编码铁律 2）
// 幂等（H-5/L1.4）：event id 去重——重放/重启续投影零重复事件
// 挂载方式（profile cordis.patch.yml）：
//   - insert:
//       - id: workloom-audit
//         name: '@workloom/runtime/plugins/workloom-audit.plugin.js'
//         config: { file: '/abs/path/audit.jsonl' }

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export const name = 'workloom-audit'

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}
function sha256(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

export function apply(ctx, config = {}) {
  const file = config.file
  if (!file) {
    console.log('[workloom-audit] 未配置 file，跳过挂载')
    return
  }
  let prev = 'GENESIS'
  let count = 0
  const seen = new Set()
  // 断点续投影（H-5）：进程重启后从既有日志恢复链头与去重集
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        seen.add(rec.id)
        prev = rec.hash
        count += 1
      } catch {
        // 尾部半行（kill -9 崩于写中途）= 截断容错：跳过不计入链
      }
    }
  }
  ctx.on('session/event', (ev) => {
    // JSON 往返净化：undefined/Date 等运行时值先归一为持久化形态，保证链可重算验证
    const clean = JSON.parse(JSON.stringify(ev ?? null))
    const id = clean?.id ?? clean?.eventId ?? sha256(canonical(clean))
    if (seen.has(id)) return // 幂等：重放零重复（H-5/L1.4）
    const hash = sha256(prev + canonical(clean))
    ev = clean
    appendFileSync(file, JSON.stringify({ id, prev, hash, ev }) + '\n')
    seen.add(id)
    prev = hash
    count += 1
  })
  console.log(`[workloom-audit] mounted · 事件桥哈希链落账 ${file}（恢复 ${count} 条）`)
}
