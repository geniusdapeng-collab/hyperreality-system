import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./base-sync.mjs', import.meta.url));
test('pull --push rejects before any repository, credential or network operation', () => {
  const result = spawnSync(process.execPath, [script, 'pull', '--repo', '/deliberately-missing-repo', '--push'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /直接推送.*main.*禁止/);
  assert.doesNotMatch(result.stderr, /目录不存在|clone|Authentication/);
});
test('parent push rejects before any clone; PR fanout is the supported mutation path', () => {
  const result = spawnSync(process.execPath, [script, 'push', '--base', '/deliberately-missing-base'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /直接推送.*main.*禁止/);
  assert.match(result.stderr, /fanout-cnb/);
});
