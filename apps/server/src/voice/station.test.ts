import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import voice from "./loommate-voice.json";
import { synthesizeVoice, voiceCacheFile, voiceCacheKey, voiceStationConfig } from "./station.js";
import { parseVoiceWav } from "./wav.js";
import { wave } from "./wav.fixture.js";
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'loommate-voice-')); dirs.push(dir); return dir; }
function config(overrides: Partial<ReturnType<typeof voiceStationConfig>> = {}) {
  const dir = temp();
  return { ...voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }), token: 'test-only', cacheDir: dir,
    sweetModel: '/local/pinned-model', ...overrides };
}
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const asFetch = (fn: (...args: any[]) => any) => fn as typeof fetch;
function cloneFetch(_url: unknown, init: RequestInit) {
  const body = JSON.parse(String(init.body)); writeFileSync(body.params.out, wave());
  return Promise.resolve(jsonResponse({ ok: true, result: { out: body.params.out } }));
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
describe("工位配置与凭据边界", () => {
  it("默认甜美女声、共享工位缓存和回环引擎", () => {
    const cfg = config(); expect(cfg.profile).toBe('loommate-sweet'); expect(cfg.enabled).toBe(true);
    expect(cfg.engineUrl).toBe('http://127.0.0.1:8100'); expect(cfg.bridgeUrl).toBe('http://127.0.0.1:9776');
  });
  it("只读取当前用户的私有常规 token 文件，env 显式优先", () => {
    const dir = temp(), file = join(dir, 'bridge-token'); writeFileSync(file, 'local-test', { mode: 0o600 });
    expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }).token).toBe('local-test');
    expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir, WORKLOOM_VOICE_BRIDGE_TOKEN: 'explicit' }).token).toBe('explicit');
    chmodSync(file, 0o644); expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }).token).toBe('');
    chmodSync(file, 0o600); rmSync(file); writeFileSync(join(dir, 'source'), 'local-test', { mode: 0o600 });
    symlinkSync(join(dir, 'source'), file); expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }).token).toBe('');
  });
  it("远端桥不自动读取本机 token，超时非法值使用有界默认值", () => {
    const dir = temp(); writeFileSync(join(dir, 'bridge-token'), 'private', { mode: 0o600 });
    const cfg = voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir, WORKLOOM_VOICE_BRIDGE_URL: 'http://remote.invalid/', WORKLOOM_VOICE_TIMEOUT_MS: 'NaN' });
    expect(cfg.token).toBe(''); expect(cfg.timeoutMs).toBe(90000); expect(cfg.bridgeUrl).toBe('http://remote.invalid');
  });
  it("只激活安装器已验证的固定模型修订", () => {
    const dir = temp(), model = join(dir, 'model'); mkdirSync(model);
    writeFileSync(join(model, 'config.json'), '{}'); writeFileSync(join(model, voice.modelFile), 'test');
    writeFileSync(join(model, voice.voiceFile), 'test-voice');
    const file = join(dir, 'loommate-voice.json');
    const manifest = { model: voice.model, revision: voice.revision, modelPath: model,
      voice: voice.voice, phonemizerVersion: voice.phonemizerVersion };
    writeFileSync(file, JSON.stringify(manifest));
    expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }).sweetModel).toBe(model);
    for (const override of [{ revision: 'wrong' }, { voice: 'zf_xiaoni' }, { phonemizerVersion: 'legacy' }]) {
      writeFileSync(file, JSON.stringify({ ...manifest, ...override }));
      expect(voiceStationConfig({ WORKLOOM_VOICE_STATION_DIR: dir }).sweetModel).toBe('');
    }
  });
});
describe("合成、缓存与回退", () => {
  it("已选普通话模型和新版发音前端不复用被否决的小妮缓存", async () => {
    const cfg = config(), text = '你好，小织。';
    const oldIdentity = JSON.stringify(['v2', 'thewh1teagle/kokoro-onnx:kokoro-v1.0.int8',
      'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c', 'zf_xiaoni', 'z', 1, '']);
    const oldFile = join(cfg.cacheDir, `${voiceCacheKey(cfg.profile, text, oldIdentity)}.wav`);
    writeFileSync(oldFile, wave());
    expect(voice.voice).toBe('zf_001'); expect(voice.phonemizerVersion).toBe('1.1');
    expect(voiceCacheFile(cfg, cfg.profile, text)).not.toBe(oldFile);
    const fn = vi.fn(async () => new Response(wave()));
    expect(await synthesizeVoice(text, { config: cfg, fetchImpl: asFetch(fn) })).toMatchObject({ ok: true, cached: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fn.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)).voice)
      .toBe(join(cfg.sweetModel, 'voices-v1.1-zh.bin'));
  });
  it("空、超过上限、路径穿越、未配置、关闭、远端均结构化拒绝", async () => {
    const cases = [
      { text: ' ', cfg: {}, profile: undefined, error: 'text_required' },
      { text: '甲'.repeat(2001), cfg: {}, profile: undefined, error: 'text_too_long' },
      { text: '你好', cfg: {}, profile: '../secret', error: 'invalid_voice_profile' },
      { text: '你好', cfg: { token: '' }, profile: undefined, error: 'voice_station_unconfigured' },
      { text: '你好', cfg: { enabled: false }, profile: undefined, error: 'voice_station_disabled' },
      { text: '你好', cfg: { engineUrl: 'http://remote.invalid' }, profile: undefined, error: 'voice_station_nonlocal' },
    ];
    const fetchImpl = vi.fn();
    for (const c of cases) expect(await synthesizeVoice(c.text, { config: config(c.cfg), profile: c.profile, fetchImpl: asFetch(fetchImpl) })).toMatchObject({ ok: false, error: c.error });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("旧客户端 profile 自动使用女声，声线和语言发送到引擎且不发送 token", async () => {
    const cfg = config(), fn = vi.fn(async () => new Response(wave()));
    const result = await synthesizeVoice('你好', { config: cfg, profile: 'zh-myvoice', fetchImpl: asFetch(fn) });
    expect(result).toMatchObject({ ok: true, profile: 'loommate-sweet', cached: false });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8100/v1/audio/speech');
    expect(JSON.parse(String(init.body))).toMatchObject({ voice: join(cfg.sweetModel, voice.voiceFile), lang_code: 'z', pitch: 1, speed: 1 });
    expect(JSON.stringify(init.headers)).not.toContain(cfg.token);
  });
  it("显式 server profile 保留个人克隆，回执 profile 与实际声音一致", async () => {
    const cfg = config({ profile: 'zh-myvoice' }), fn = vi.fn(cloneFetch);
    const r = await synthesizeVoice('你好', { config: cfg, fetchImpl: asFetch(fn) });
    expect(r).toMatchObject({ ok: true, profile: 'zh-myvoice' });
    expect(fn.mock.calls[0]![0]).toBe('http://127.0.0.1:9776/action');
    expect((fn.mock.calls[0]![1].headers as Record<string,string>).authorization).toBe('Bearer test-only');
  });
  it("有效缓存直接播放；损坏缓存重新合成；模型和不同声线互不混用", async () => {
    const cfg = config(), fn = vi.fn(async () => new Response(wave())), file = voiceCacheFile(cfg, cfg.profile, '早安');
    writeFileSync(file, 'RIFF-fake');
    expect(await synthesizeVoice('早安', { config: cfg, fetchImpl: asFetch(fn) })).toMatchObject({ cached: false });
    expect(await synthesizeVoice('早安', { config: cfg, fetchImpl: asFetch(fn) })).toMatchObject({ cached: true });
    expect(fn).toHaveBeenCalledTimes(1); expect(parseVoiceWav(readFileSync(file)).data.length).toBe(2400);
    expect(file).not.toBe(voiceCacheFile(cfg, 'zh-myvoice', '早安'));
    expect(voiceCacheKey('a','text','revision1')).not.toBe(voiceCacheKey('a','text','revision2'));
  });
  it("缺模型、HTTP 失败、损坏 WAV 均优先尝试个人克隆", async () => {
    for (const mode of ['missing', 'http', 'corrupt']) {
      const cfg = config(mode === 'missing' ? { sweetModel: '' } : {});
      const fn = vi.fn(async (url, init) => String(url).endsWith('/action') ? cloneFetch(url, init)
        : mode === 'http' ? new Response('failed', { status: 503 }) : new Response('not-wav'));
      expect(await synthesizeVoice('你好', { config: cfg, fetchImpl: asFetch(fn) })).toMatchObject({ ok: true, profile: 'zh-myvoice' });
      expect(fn.mock.calls.some(c => String(c[0]).endsWith('/action'))).toBe(true);
    }
  });
  it("女声超时中止后克隆仍可完成", async () => {
    const cfg = config({ primaryTimeoutMs: 5 });
    const fn = async (url: unknown, init: RequestInit) => String(url).endsWith('/action') ? cloneFetch(url, init)
      : new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError'))));
    expect(await synthesizeVoice('你好', { config: cfg, fetchImpl: asFetch(fn) })).toMatchObject({ ok: true, profile: 'zh-myvoice' });
  });
  it("并发相同文本只合成一次，长文本按顺序合成并保存完整音频", async () => {
    const cfg = config(), fn = vi.fn(async () => new Response(wave()));
    const text = '甲'.repeat(81) + '。最后一句！';
    const results = await Promise.all(Array.from({length: 8}, () => synthesizeVoice(text, { config: cfg, fetchImpl: asFetch(fn) })));
    expect(results.every(r => r.ok)).toBe(true); expect(fn).toHaveBeenCalledTimes(3);
    const bodies = fn.mock.calls.map(c => JSON.parse(String((c as unknown as [unknown,RequestInit])[1].body)).input);
    expect(bodies.join('')).toBe(text);
  });
  it("失败请求不会永久锁死，下次恢复后可重新合成", async () => {
    const cfg = config(), bad = asFetch(async () => { throw new Error('offline'); });
    expect(await synthesizeVoice('重试', { config: cfg, fetchImpl: bad })).toMatchObject({ ok: false });
    expect(await synthesizeVoice('重试', { config: cfg, fetchImpl: asFetch(async () => new Response(wave())) })).toMatchObject({ ok: true });
  });
  it("克隆同意门禁失败保留结构化原因，失败信息不泄漏凭据", async () => {
    const cfg = config({ sweetModel: '' });
    const result = await synthesizeVoice('你好', { config: cfg, fetchImpl: asFetch(async () => jsonResponse({ok:false,error:'consent_required',message:'denied test-only'})) });
    expect(result).toMatchObject({ ok: false, error: 'consent_required', profile: 'zh-myvoice' });
    expect(JSON.stringify(result)).not.toContain(cfg.token);
  });
  it("克隆回执不得指定请求外路径，不得把不存在或伪 WAV 当成功", async () => {
    const cfg = config({ sweetModel: '' });
    for (const out of [join(cfg.cacheDir, 'other.wav'), undefined]) {
      expect(await synthesizeVoice('你好', { config: cfg, fetchImpl: asFetch(async () => jsonResponse({ ok: true, result: { out } })) })).toMatchObject({ ok: false });
    }
  });
  it("克隆超时与磁盘写失败均返回失败", async () => {
    const cfg = config({ profile:'zh-myvoice', timeoutMs:5 });
    const fn = (_url: unknown, init: RequestInit) => new Promise<Response>((_r,reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timeout','AbortError'))));
    expect(await synthesizeVoice('你好', { config:cfg, fetchImpl:asFetch(fn) })).toMatchObject({error:'voice_station_timeout'});
    const file = join(temp(),'file'); writeFileSync(file,'not-a-directory');
    expect(await synthesizeVoice('磁盘异常', { config:config({cacheDir:file}), fetchImpl:asFetch(async () => new Response(wave())) })).toMatchObject({ok:false});
  });
});
