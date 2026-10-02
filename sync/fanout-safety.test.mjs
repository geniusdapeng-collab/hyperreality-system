import test from 'node:test';
import assert from 'node:assert/strict';
import { main, redactFanout } from './fanout-cnb.mjs';
import { gitAuthenticationEnvironment } from '../scripts/tools/cnb-api.mjs';

test('fanout rejects a foreign, insecure or credential-bearing origin before requesting credentials', async () => {
  const beforeArgv = process.argv;
  const beforeToken = process.env.CNB_TOKEN;
  try {
    delete process.env.CNB_TOKEN;
    for (const url of ['https://foreign.example', 'http://cnb.cool', 'https://person:fixture@cnb.cool', 'https://cnb.cool/other', 'https://cnb.cool?redirect=other']) {
      process.argv = [process.execPath, 'fanout-cnb.mjs', '--base-url', url];
      await assert.rejects(main(), /base-url.*https:\/\/cnb\.cool/u);
    }
  } finally {
    process.argv = beforeArgv;
    if (beforeToken === undefined) delete process.env.CNB_TOKEN; else process.env.CNB_TOKEN = beforeToken;
  }
});

test('fanout error logs remove the actual Basic credential as well as the original token', () => {
  const token = 'test-only-fanout-private-fixture';
  const header = Buffer.from('cnb:' + token).toString('base64');
  const encodedToken = encodeURIComponent(token);
  const result = redactFanout(`${token} ${encodedToken} Authorization: Basic ${header}`, token);
  assert.equal(result.includes(token), false);
  assert.equal(result.includes(header), false);
});

test('CNB Git authentication is scoped to the canonical HTTPS origin and disables persistent helpers', () => {
  const env = gitAuthenticationEnvironment('fanout-private-fixture', {});
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://cnb.cool/.extraHeader');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(Object.values(env).includes('http.extraHeader'), false);
});
