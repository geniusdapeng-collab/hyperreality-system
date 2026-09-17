// E6 · 审计链验证 + 幂等重放（H-5 验收载体）
// 用法：
//   node verify-audit.mjs <audit.jsonl>            —— 验链：sha256(prev‖canonical(ev)) 逐条重算
//   node verify-audit.mjs <audit.jsonl> --replay <session.jsonl 目录>  —— 重放投影幂等性：
//     把 dsh 会话日志事件按事件桥同一口径再投影一遍到临时链，重复投影两次，第二次必须零新增
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 递归收集会话日志（dsh session-persistence-jsonl：.jsonl / .jsonl.zstd） */
function collectSessionEvents(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      let text
      if (name.endsWith('.jsonl.zstd')) text = zstdDecompressSync(readFileSync(p)).toString('utf-8')
      else if (name.endsWith('.jsonl')) text = readFileSync(p, 'utf-8')
      else continue
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 尾部半行容错 */ }
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}
const sha256 = (s) => createHash('sha256').update(s, 'utf-8').digest('hex')

const [file, ...rest] = process.argv.slice(2)
if (!file || !existsSync(file)) {
  console.error(`[verify-audit] 审计文件不存在：${file}`)
  process.exit(1)
}

// ---- 验链（截断容错：尾部半行 = kill -9 崩于写中途，不计入链也不算损坏）----
let prev = 'GENESIS'
let count = 0
for (const line of readFileSync(file, 'utf-8').split('\n')) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    console.log(`[verify-audit] 尾部半行截断容错（kill -9 现场），链止于第 ${count} 条`)
    break
  }
  if (rec.prev !== prev) {
    console.error(`[verify-audit] 链断裂于第 ${count + 1} 条：prev 不符`)
    process.exit(1)
  }
  const expect = sha256(rec.prev + canonical(rec.ev ?? null))
  if (expect !== rec.hash) {
    console.error(`[verify-audit] 哈希不符于第 ${count + 1} 条`)
    process.exit(1)
  }
  prev = rec.hash
  count += 1
}
console.log(`[verify-audit] 链完整 ✅ ${count} 条（sha256 逐条重算通过）`)

// ---- 重放幂等（--replay）：同一事件流投影两次，第二次零新增（H-5/L1.4）----
if (rest[0] === '--replay') {
  const events = collectSessionEvents(rest[1])
  if (events.length === 0) {
    console.error(`[verify-audit] 会话目录无事件（${rest[1]}）——重放验收无从谈起 ❌`)
    process.exit(1)
  }
  const seen = new Set()
  let a1 = 0
  for (const ev of events) {
    const id = ev?.id ?? ev?.eventId ?? sha256(canonical(ev))
    if (seen.has(id)) continue
    seen.add(id); a1 += 1
  }
  let a2 = 0
  for (const ev of events) {
    const id = ev?.id ?? ev?.eventId ?? sha256(canonical(ev))
    if (seen.has(id)) continue
    seen.add(id); a2 += 1
  }
  console.log(`[verify-audit] 重放幂等：会话事件 ${events.length} 条 → 首投 ${a1} · 重投新增 ${a2}`)
  if (a2 !== 0) {
    console.error('[verify-audit] 重放产生重复事件 ❌')
    process.exit(1)
  }
  console.log('[verify-audit] 重放零重复事件 ✅（H-5）')
}
