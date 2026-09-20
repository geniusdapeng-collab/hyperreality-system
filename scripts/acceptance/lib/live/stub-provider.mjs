/**
 * stub-provider.mjs · 生产实测执行器的**自检替身**（RDAS v3.1 §19）
 *
 * 用途只有一个：在没有真实凭据时证明 live.mjs 的管道本身可用
 * （预算闸 → 适配器 → 产物落盘 → 回执 → 报告），结果一律标 `selftest`，
 * **不得**作为生产实测证据，也不得写进 P 域通过判定。
 *
 * 端点：
 *   POST /v1/chat/completions                      OpenAI 兼容（文本 + image_url 多模态）
 *   GET  /v1/models
 *   POST /api/v3/images/generations                Seedream 形态（同步）
 *   POST /api/v3/contents/generations/tasks        Seedance 形态（异步）
 *   GET  /api/v3/contents/generations/tasks/:id    轮询
 *   GET  /artifacts/:name                          产物下载（1×1 PNG / 伪 MP4）
 */
import http from "node:http";

/** 1×1 透明 PNG */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 最小可识别容器（不是可播放视频；仅用于产物落盘自检） */
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isomiso2mp41"),
  Buffer.alloc(512),
]);

export async function startStubProvider({ port = 0, durationSeconds = 12 } = {}) {
  const tasks = new Map();
  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(200, { object: "list", data: [{ id: "stub-flash", object: "model" }] });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJson(req);
      const userMsg = (body?.messages ?? []).find((m) => m?.role === "user");
      const content = userMsg?.content;
      const hasImage = Array.isArray(content) && content.some((c) => c?.type === "image_url");
      const text = Array.isArray(content) ? (content.find((c) => c?.type === "text")?.text ?? "") : String(content ?? "");
      const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
      const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m?.role === "tool");
      const marker = hasImage ? "STUB-IMAGE-SEEN" : "STUB-OK";
      const answer = hasTools && hasToolResult
        ? `${marker} · 已完成工具调用与核验：${text.replace(/\s+/gu, " ").slice(0, 400)}\nTASK_COMPLETE`
        : `${marker} · ${text.replace(/\s+/gu, " ").slice(0, 400)}`;
      const id = `chatcmpl-stub-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body?.model ?? "stub-flash";
      // 工具循环：第一次带 tools 且尚无 tool 结果 → 返回 bash 工具调用（与 E6 mock 同口径，供围栏瀑布判定）
      if (hasTools && !hasToolResult) {
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo workloom-live\"}" } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        return json(200, {
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_stub_1", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo workloom-live\"}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
      }
      // dsh 走流式（SSE）：stream=true 时必须按 data: {...} 分片返回，否则 agent loop 读不到内容
      if (body?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const piece of answer.match(/.{1,16}/gu) ?? [answer]) {
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(200, {
        id: `chatcmpl-stub-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? "stub-flash",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    }
    if (req.method === "GET" && url.pathname === "/rules") {
      return json(200, [
        { rule_id: "STUB-R1", name: "自检 bash 放行", level: "auto", actions: ["bash"] },
        { rule_id: "STUB-R2", name: "自检写操作挂起", level: "review", actions: ["write", "delete"] },
      ]);
    }
    if (req.method === "POST" && url.pathname === "/api/v3/images/generations") {
      const body = await readJson(req);
      const n = Math.max(1, Number(body?.sequential_image_generation_options?.max_images ?? 1));
      const base = `http://127.0.0.1:${boundPort}`;
      return json(200, {
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? "stub-image",
        data: Array.from({ length: n }, (_, i) => ({ url: `${base}/artifacts/stub-image-${i + 1}.png` })),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v3/contents/generations/tasks") {
      const body = await readJson(req);
      const id = `stub-video-${tasks.size + 1}`;
      tasks.set(id, { duration: Number(body?.duration ?? durationSeconds) });
      return json(200, { id, model: body?.model ?? "stub-video", status: "queued" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v3/contents/generations/tasks/")) {
      const id = url.pathname.split("/").pop();
      const t = tasks.get(id);
      if (!t) return json(404, { error: { message: "task not found" } });
      return json(200, {
        id,
        status: "succeeded",
        duration: t.duration,
        content: { video_url: `http://127.0.0.1:${boundPort}/artifacts/${id}.mp4` },
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const isVideo = url.pathname.endsWith(".mp4");
      const buf = isVideo ? FAKE_MP4 : PNG_1PX;
      res.writeHead(200, { "content-type": isVideo ? "video/mp4" : "image/png", "content-length": buf.length });
      return res.end(buf);
    }
    if (req.method === "GET" && url.pathname === "/health") return json(200, { ok: true, stub: true });
    return json(404, { error: { message: `stub 未实现：${req.method} ${url.pathname}` } });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = server.address().port;
  boundPort = actualPort;
  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    v1BaseUrl: `http://127.0.0.1:${actualPort}/v1`,
    arkBaseUrl: `http://127.0.0.1:${actualPort}/api/v3`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}
