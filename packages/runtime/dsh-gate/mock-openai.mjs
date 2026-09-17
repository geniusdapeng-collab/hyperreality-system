// E6 · Mock LLM（OpenAI 兼容 /v1/chat/completions；D4 纪律：无真实 Key 全流程可跑）
// 剧本（确定性）：
//   ① 请求带 tools 且消息中无 tool 结果 → 返回一次 bash 工具调用（echo workloom-gate）
//   ② 消息中已有 tool 结果 → 流式返回最终答案「TASK_COMPLETE …」（DSH_SLOW_MS>0 时每段延迟，供 kill -9 窗口）
//   ③ 无 tools（如会话标题生成）→ 直接短答
// 另挂 /rules：为 workloom-fence 插件供围栏规则（bash → auto，其余未命中走插件默认）
import http from 'node:http'

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8799)
const SLOW_MS = Number(process.env.DSH_SLOW_MS ?? 0)

const RULES = [
  { rule_id: 'GATE-R1', name: '门禁 bash 放行', level: 'auto', actions: ['bash'] },
  { rule_id: 'GATE-R2', name: '门禁默认挂起', level: 'review', actions: ['write', 'delete'] },
]

function chunk(id, delta, finish = null) {
  return `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'mock-flash',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function fullMessage(message, finish) {
  return {
    id: `chatcmpl-gate-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: 'mock-flash',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  if (req.url === '/rules') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RULES))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-flash', object: 'model' }] }))
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404); res.end(); return
  }
  const body = JSON.parse(await new Promise((resolve) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d || '{}'))
  }))
  const messages = body.messages ?? []
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  const hasToolResult = messages.some((m) => m.role === 'tool')
  const id = `chatcmpl-gate-${Date.now()}`

  if (hasTools && !hasToolResult) {
    // ① 发起一次 bash 工具调用（经 dsh tools/pre-execute 瀑布 → workloom-fence 判定）
    const message = {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'call_gate_1', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'echo workloom-gate-ok' }) },
      }],
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(chunk(id, { role: 'assistant', content: null, tool_calls: [{ index: 0, ...message.tool_calls[0] }] }))
      res.write(chunk(id, {}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(fullMessage(message, 'tool_calls')))
    }
    return
  }

  // ②/③ 最终答案
  const answer = hasToolResult
    ? 'TASK_COMPLETE 最小任务已交付：bash 工具调用经围栏瀑布放行并回执。'
    : 'GATE_TITLE 门禁会话'
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(chunk(id, { role: 'assistant', content: '' }))
    for (const seg of answer.match(/.{1,8}/gs) ?? [answer]) {
      if (SLOW_MS > 0) await sleep(SLOW_MS) // kill -9 窗口
      res.write(chunk(id, { content: seg }))
    }
    res.write(chunk(id, {}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  } else {
    if (SLOW_MS > 0) await sleep(SLOW_MS * 4)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fullMessage({ role: 'assistant', content: answer }, 'stop')))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening http://127.0.0.1:${PORT}（/v1/chat/completions + /rules）`)
})
