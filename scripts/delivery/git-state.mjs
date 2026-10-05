/** Append-only control branch; ordinary fast-forward pushes implement compare-and-swap. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { appendEvent, emptyState, STATE_BRANCH, validateState, validRepoSlug } from './queue-model.mjs';
import { gitAuthenticationEnvironment, redactCredentials } from '../tools/cnb-api.mjs';

const execute = promisify(execFile);
export async function git(args, { cwd, token, input, remote, raw = false } = {}) {
  const env = token ? gitAuthenticationEnvironment(token) : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (remote && !remote.startsWith('https://cnb.cool/') && token) throw new Error('Git credential destination rejected');
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'WorkLoom delivery';
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'delivery@workloom.invalid';
  try {
    if (input !== undefined) {
      // execFile's promisified interface does not accept stdin input; stream it without a shell.
      const { spawn } = await import('node:child_process');
      return await new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = ''; let oversized = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) { oversized = true; child.kill('SIGKILL'); } });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0 && !oversized) resolve(raw ? stdout : stdout.trim());
          else reject(Object.assign(new Error(redactCredentials(`Git failed (${code ?? signal}): ${stderr}`, token)), { code }));
        });
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.kill('SIGKILL'); });
        child.stdin.end(input);
      });
    }
    const result = await execute('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return raw ? result.stdout : result.stdout.trim();
  } catch (error) {
    throw Object.assign(new Error(redactCredentials(error.message, token)), { code: error.code, signal: error.signal });
  }
}

export class GitStateStore {
  constructor({ repo, token, remote = `https://cnb.cool/${repo}.git`, branch = STATE_BRANCH, retries = 4 }) {
    if (!validRepoSlug(repo)) throw new Error('Invalid repository slug');
    if (token && remote !== `https://cnb.cool/${repo}.git`) throw new Error('Unexpected credential destination');
    if (!/^automation\/[A-Za-z0-9_.-]+$/.test(branch)) throw new Error('Invalid state branch');
    this.repo = repo; this.token = token; this.remote = remote; this.branch = branch; this.retries = retries;
  }

  async withRepository(operation) {
    const directory = await mkdtemp(join(tmpdir(), 'workloom-delivery-state-'));
    const run = (args, options = {}) => git(args, { cwd: directory, token: this.token, remote: this.remote, ...options });
    try {
      await run(['init', '--quiet']);
      return await operation(run);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async load(run) {
    const refs = await run(['ls-remote', this.remote, `refs/heads/${this.branch}`]);
    if (!refs) return { state: emptyState(this.repo), parent: null };
    const parent = refs.split(/\s/)[0];
    await run(['fetch', '--quiet', '--no-tags', this.remote, `refs/heads/${this.branch}`]);
    // FETCH_HEAD can be newer than the first read. Its content and parent must stay paired.
    const actual = await run(['rev-parse', 'FETCH_HEAD']);
    const raw = await run(['show', `${actual}:state.json`]);
    return { state: validateState(JSON.parse(raw), this.repo), parent: actual || parent };
  }

  async read() { return this.withRepository(async run => (await this.load(run)).state); }

  /** Mutators must be pure. Network/Git effects occur only after this transaction returns. */
  async mutate(operation, { id = randomUUID(), now = Date.now() } = {}) {
    return this.withRepository(async run => {
      for (let attempt = 0; attempt < this.retries; attempt++) {
        const { state, parent } = await this.load(run);
        if (state.events.some(event => event.kind === 'transaction' && event.data.id === id)) return { state, recovered: true };
        const result = operation(state);
        if (result instanceof Promise) throw new Error('State mutator cannot perform asynchronous effects');
        appendEvent(state, 'transaction', { id }, now);
        validateState(state, this.repo);
        const blob = await run(['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(state, null, 2)}\n` });
        const tree = await run(['mktree'], { input: `100644 blob ${blob}\tstate.json\n` });
        const commit = await run(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: `chore(ci): delivery state ${id}\n` });
        try {
          await run(['push', '--porcelain', this.remote, `${commit}:refs/heads/${this.branch}`]);
        } catch (error) {
          // A lost response is not permission to retry an external action. Read the durable transaction first.
          const after = await this.load(run);
          if (after.state.events.some(event => event.kind === 'transaction' && event.data.id === id)) return { state: after.state, result, recovered: true };
          if (after.parent === parent || attempt === this.retries - 1) throw error;
          continue; // An ordinary push lost a CAS race. Recompute the pure mutation from the new state.
        }
        const after = await this.load(run);
        if (!after.state.events.some(event => event.kind === 'transaction' && event.data.id === id)) throw new Error('State write could not be verified');
        return { state: after.state, result, commit };
      }
      throw new Error('State CAS retries exhausted');
    });
  }
}
