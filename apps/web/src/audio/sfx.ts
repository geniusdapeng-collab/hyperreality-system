/**
 * sfx · 程序化音效合成（WebAudio 振荡器，零音频资产、零版权风险）
 *
 * 每个预设 = 一组「音元」（振荡器类型/频率/起止时间/包络/音量），
 * 由 AudioEngine.play() 在同一 AudioContext 上调度播放。
 * 频率单位 Hz，时间单位秒（相对触发时刻）。
 */

export type ToneType = OscillatorType;

export interface ToneSpec {
  type: ToneType;
  /** 起始频率；可滑到 freq2 */
  freq: number;
  freq2?: number;
  /** 触发偏移 */
  at?: number;
  /** 时长 */
  dur: number;
  /** 峰值音量 0-1 */
  vol: number;
  /** 包络：attack/decay（剩余为 sustain→release 淡出） */
  attack?: number;
  decay?: number;
}

export interface SfxPreset {
  tones: ToneSpec[];
  /** 附噪声冲击（盖章/键盘感） */
  noise?: { at?: number; dur: number; vol: number; lowpass?: number };
}

const T = (type: ToneType, freq: number, dur: number, vol: number, extra: Partial<ToneSpec> = {}): ToneSpec =>
  ({ type, freq, dur, vol, ...extra });

/** 反馈层（sfx 总线） */
export const SFX_FEEDBACK: Record<string, SfxPreset> = {
  /** 审批盖章：低频方波短促 + 噪声冲击 */
  approve: {
    tones: [T("square", 180, 0.07, 0.5, { attack: 0.004, decay: 0.05 }), T("square", 120, 0.06, 0.3, { at: 0.05 })],
    noise: { dur: 0.035, vol: 0.35, lowpass: 2400 },
  },
  /** 驳回：下行双音 */
  reject: { tones: [T("sine", 330, 0.09, 0.4), T("sine", 220, 0.14, 0.4, { at: 0.09 })] },
  /** 派活接单：轻快上行 */
  assign: { tones: [T("sine", 520, 0.06, 0.35), T("sine", 780, 0.1, 0.35, { at: 0.06 })] },
  /** 捷报琶音：上行三连 */
  cheer: {
    tones: [T("sine", 523, 0.1, 0.35), T("sine", 659, 0.1, 0.35, { at: 0.09 }), T("sine", 784, 0.22, 0.4, { at: 0.18 })],
  },
  /** 风铃提示（新请示）：滑音 + 泛音 */
  chime: {
    tones: [
      T("sine", 1320, 0.4, 0.3, { freq2: 1760, attack: 0.01, decay: 0.3 }),
      T("sine", 2640, 0.3, 0.12, { at: 0.02, decay: 0.25 }),
    ],
  },
  /** 轮盘弹出 */
  pop: { tones: [T("sine", 700, 0.05, 0.25, { freq2: 900 })] },
  /** 拖放落点 */
  drop: { tones: [T("sine", 440, 0.05, 0.3), T("sine", 660, 0.08, 0.28, { at: 0.045 })] },
  /** 切换 */
  tick: { tones: [T("square", 900, 0.025, 0.16)] },
  /** 错误 */
  error: { tones: [T("sawtooth", 200, 0.12, 0.3), T("sawtooth", 160, 0.16, 0.28, { at: 0.1 })] },
  /** 键盘"嗒"（环境层随机用） */
  key: { tones: [T("square", 1800, 0.014, 0.06)], noise: { dur: 0.012, vol: 0.05, lowpass: 5000 } },
};

/** 仪式层（ritual 总线） */
export const SFX_RITUAL: Record<string, SfxPreset> = {
  /** 晨会号角：三和弦渐强 */
  fanfare: {
    tones: [
      T("sawtooth", 262, 0.55, 0.22, { attack: 0.06 }),
      T("sawtooth", 330, 0.55, 0.18, { attack: 0.06 }),
      T("sawtooth", 392, 0.6, 0.2, { attack: 0.06 }),
      T("sawtooth", 523, 0.7, 0.22, { at: 0.3, attack: 0.04 }),
    ],
  },
  /** 夜班鼓点：两低一高 */
  nightDrum: {
    tones: [T("sine", 90, 0.25, 0.55, { decay: 0.2 }), T("sine", 90, 0.25, 0.45, { at: 0.32, decay: 0.2 }), T("sine", 140, 0.3, 0.4, { at: 0.64, decay: 0.25 })],
  },
  /** 庆典钟声：长衰减 + 五度叠音 */
  bell: {
    tones: [
      T("sine", 880, 1.8, 0.4, { attack: 0.005, decay: 1.4 }),
      T("sine", 1320, 1.4, 0.2, { at: 0.02, decay: 1.1 }),
      T("sine", 1760, 1.0, 0.1, { at: 0.04, decay: 0.8 }),
    ],
  },
  /** 熔断警报：往复三连 */
  alarm: {
    tones: [
      T("triangle", 620, 0.16, 0.45), T("triangle", 480, 0.16, 0.45, { at: 0.18 }),
      T("triangle", 620, 0.16, 0.45, { at: 0.36 }), T("triangle", 480, 0.16, 0.45, { at: 0.54 }),
      T("triangle", 620, 0.2, 0.5, { at: 0.72 }),
    ],
  },
  /** 荣誉揭幕：上行滑音 + 钟 */
  unveil: {
    tones: [
      T("sine", 440, 0.5, 0.25, { freq2: 880, attack: 0.02 }),
      T("sine", 880, 1.2, 0.3, { at: 0.45, decay: 1.0 }),
    ],
  },
};

export const ALL_SFX: Record<string, SfxPreset> = { ...SFX_FEEDBACK, ...SFX_RITUAL };
