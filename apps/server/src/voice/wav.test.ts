import { describe, expect, it } from "vitest";
import { joinVoiceWavs, parseVoiceWav, splitVoiceText } from "./wav.js";
import { wave } from "./wav.fixture.js";
describe("语音 WAV 完整性与分段", () => {
  it("有效 PCM 可解析，错误体、截断和错误 RIFF 大小不可缓存", () => {
    expect(parseVoiceWav(wave()).data.length).toBe(2400);
    for (const bad of [Buffer.from('HTTP error'), wave().subarray(0, 200), Buffer.concat([wave(), Buffer.from('extra')])])
      expect(() => parseVoiceWav(bad)).toThrow();
    const malformed = wave(); malformed.writeUInt32LE(999999, 40);
    expect(() => parseVoiceWav(malformed)).toThrow();
  });
  it("拒绝无效采样率、位深和块对齐", () => {
    for (const [offset, value] of [[24, 0], [28, 123], [32, 9], [34, 8]]) {
      const b = wave(); b.writeUInt16LE(value!, offset!); expect(() => parseVoiceWav(b)).toThrow();
    }
  });
  it("分段拼接保留首尾与停顿，声学格式不同则失败", () => {
    const result = parseVoiceWav(joinVoiceWavs([wave(10), wave(20)]));
    expect(result.data.length).toBe(4800 + 7680);
    expect(result.data.readInt16LE(0)).toBe(10);
    expect(result.data.readInt16LE(result.data.length - 2)).toBe(20);
    const other = wave(); other.writeUInt32LE(16000, 24); other.writeUInt32LE(32000, 28);
    expect(() => joinVoiceWavs([wave(), other])).toThrow("incompatible_voice_wavs");
    expect(() => joinVoiceWavs([])).toThrow();
  });
  it("24 位奇数字节音频保留数据并正确补齐 RIFF 填充", () => {
    const b = Buffer.alloc(44 + 513 + 1);
    wave().subarray(0, 44).copy(b);
    b.writeUInt32LE(b.length - 8, 4);
    b.writeUInt32LE(72000, 28); b.writeUInt16LE(3, 32); b.writeUInt16LE(24, 34);
    b.writeUInt32LE(513, 40);
    const joined = joinVoiceWavs([b]);
    expect(joined.length).toBe(b.length);
    expect(parseVoiceWav(joined).data.length).toBe(513);
  });
  it("长文本与 emoji 按码点完整分段，无静默截断", () => {
    const text = '你好！' + '甲'.repeat(180) + '🙂\n最后一句。';
    const chunks = splitVoiceText(text);
    expect(chunks.every(c => Array.from(c).length <= 80)).toBe(true);
    expect(chunks.join('')).toBe(text.replace(/\n/g, ''));
    expect(splitVoiceText('  ')).toEqual([]);
  });
});
