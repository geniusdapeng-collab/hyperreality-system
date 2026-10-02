/** Runner-owned deterministic HTTP fixture. It has no provider, database or external target. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const FAULTS = new Set(['empty-events', 'wrong-thread', 'running', 'authorization-leak']);
export async function createOutcomeFixture({ fault = null } = {}) {
  if (fault !== null && !FAULTS.has(fault)) throw new Error('Unknown outcome selftest fault');
  const token = randomUUID(); const requests = []; const threads = [];
  const server = createServer(async (req, res) => {
    const send = (status, data, code) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(code ? { error: { data: { code }, message: code } } : { result: { data } }));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const procedure = url.pathname.replace(/^\/trpc\//, '');
      if (!['auth.loginAs', 'threads.list', 'threads.dispatch', 'threads.get', 'threads.events'].includes(procedure)) { send(404, null, 'NOT_FOUND'); return; }
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 16384) { send(413, null, 'PAYLOAD_TOO_LARGE'); return; }
      }
      const input = req.method === 'POST' ? JSON.parse(body || '{}') : JSON.parse(url.searchParams.get('input') || '{}');
      const authorized = req.headers.authorization === `Bearer ${token}`;
      requests.push({ procedure, input, auth: authorized });
      if (procedure === 'auth.loginAs' && req.method === 'POST') { send(200, { token, identity: { workspaceId: 'ws-fixture' } }); return; }
      if (!authorized) { send(401, null, 'UNAUTHORIZED'); return; }
      if (procedure === 'threads.list') { send(200, threads); return; }
      if (procedure === 'threads.dispatch') {
        if (req.method !== 'POST') { send(405, null, 'METHOD_NOT_ALLOWED'); return; }
        if (typeof input.title !== 'string' || input.title.length > 500) { send(400, null, 'BAD_REQUEST'); return; }
        const thread = { id: `T-${threads.length + 1}`, title: input.title, status: fault === 'running' ? 'running' : 'completed', preset_key: input.presetKey };
        threads.push(thread); send(200, { threadId: thread.id, kind: 'routed', status: thread.status }); return;
      }
      const thread = threads.find(row => row.id === input.threadId);
      if (!thread) { send(404, null, 'NOT_FOUND'); return; }
      if (procedure === 'threads.get') { send(200, fault === 'wrong-thread' ? { ...thread, id: 'T-other' } : thread); return; }
      const text = fault === 'authorization-leak' ? 'Authorization: Basic ' + ['Q25iOn', 'ByaXZhdGUtZml4dHVyZQ=='].join('') : '需要处理一项行业待办，未完成项请负责人核对。';
      send(200, fault === 'empty-events' ? [] : [{ event_id: 'E-101', object: { id: input.threadId }, context: { workspace_id: 'ws-fixture' },
        who: { id: thread.preset_key }, decision: { action: 'ask.answer', after: { text }, params: { via: 'rule' } }, model_trace: { model_id: 'mock-001' } }]);
    } catch (error) {
      if (!res.headersSent) send(400, null, 'BAD_REQUEST');
      else res.destroy(error);
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, threads,
    async close() { server.closeIdleConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); } };
}
