/** A loopback model-only broker holds CNB credentials outside model tool processes. */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validRepoSlug } from './queue-model.mjs';

const MODEL_PATH = /^\/(?:v1\/)?(?:messages(?:\/count_tokens)?|chat\/completions|responses)$/;
const MAX_BODY = 8 * 1024 * 1024;

export async function modelGateway({ repo, token, endpoint = 'https://api.cnb.cool', request = fetch }) {
  if (!validRepoSlug(repo) || !token || new URL(endpoint).origin !== 'https://api.cnb.cool') throw new Error('Model gateway identity is invalid');
  const controllers = new Set();
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 180_000);
    outgoing.once('close', () => { if (!outgoing.writableFinished) controller.abort(); });
    try {
      // Do not normalize a traversal/absolute request into an allowed route.
      const route = String(incoming.url ?? '');
      if (incoming.method !== 'POST' || !MODEL_PATH.test(route.split('?')[0]) || /[\\\r\n%]/.test(route) || !String(incoming.headers['content-type'] ?? '').startsWith('application/json')) {
        outgoing.writeHead(403); outgoing.end('Model-only route required'); return;
      }
      let size = 0; const chunks = [];
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > MAX_BODY) { outgoing.writeHead(413); outgoing.end('Model request exceeds bounds'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks); JSON.parse(body.toString());
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-api-key': token };
      for (const key of ['anthropic-version', 'anthropic-beta']) if (typeof incoming.headers[key] === 'string') headers[key] = incoming.headers[key];
      const response = await request(`https://api.cnb.cool/${repo}/-/ai${route}`, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal });
      // Never reflect backend credentials, redirect locations, cookies or trace bodies to tools.
      if (!response.ok) { await response.body?.cancel(); outgoing.writeHead(response.status >= 400 && response.status <= 599 ? response.status : 502); outgoing.end('CNB model gateway request failed'); return; }
      outgoing.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      if (!outgoing.destroyed) outgoing.end('Model request failed');
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
  server.requestTimeout = 180_000; server.headersTimeout = 30_000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); }); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  } };
}
