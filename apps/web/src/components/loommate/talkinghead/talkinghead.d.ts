/** TalkingHead 最小类型声明（vendor 引擎 MIT；只声明我们使用的公开面） */
declare module "*talkinghead.mjs" {
  export interface TalkingHeadOptions {
    ttsEndpoint?: string;
    cameraView?: "full" | "mid" | "upper" | "head";
    cameraRotateEnable?: boolean;
    cameraZoomEnable?: boolean;
    cameraPanEnable?: boolean;
    cameraY?: number;
    cameraX?: number;
    cameraDistance?: number;
    avatarMood?: string;
    lipsyncLang?: string;
    lightAmbientIntensity?: number;
    lightDirectIntensity?: number;
  }
  export interface AvatarSpec {
    url: string;
    body?: "M" | "F";
    lipsyncLang?: string;
    avatarMood?: string;
    baseline?: Record<string, number>;
    retarget?: Record<string, unknown>;
    modelDynamicBones?: unknown[];
  }
  export class TalkingHead {
    constructor(node: HTMLElement, opt?: TalkingHeadOptions);
    showAvatar(avatar: AvatarSpec, onprogress?: (ev: unknown) => void, onerror?: (err: unknown) => void): Promise<void>;
    start(): void;
    stop(): void;
    setView(view: string, opt?: Record<string, unknown>): void;
    setMood(mood: string): void;
    getMoodNames(): string[];
    setValue(mt: string, val: number, ms?: number | null): void;
    getValue(mt: string): number;
    setFixedValue(mt: string, val: number, ms?: number | null): void;
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    stopGesture(ms?: number): void;
    lookAt(x: number, y: number, t: number): void;
  }
}
