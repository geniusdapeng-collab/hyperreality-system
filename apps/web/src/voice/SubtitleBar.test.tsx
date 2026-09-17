// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleBar } from "./SubtitleBar";
import { VoiceEngine, type Utterance, type VoicePriority } from "./VoiceEngine";

const line = (text: string, priority: VoicePriority = "ceremony", persona = "织伴"): Utterance => ({
  role: "test-role",
  persona,
  text,
  priority,
});

describe("SubtitleBar 字幕队列", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<SubtitleBar />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function bar(): HTMLDivElement {
    const element = container.querySelector<HTMLDivElement>('[aria-live="polite"]');
    if (!element) throw new Error("字幕条未渲染");
    return element;
  }

  async function emit(utterance: Utterance): Promise<void> {
    await act(async () => VoiceEngine.speak(utterance));
  }

  it("普通字幕严格 FIFO，后到字幕不会抢占当前计时器", async () => {
    await emit(line("第一条"));
    await emit(line("第二条"));
    expect(bar().textContent).toContain("第一条");
    expect(bar().textContent).not.toContain("第二条");

    await act(async () => vi.advanceTimersByTimeAsync(2_200));
    expect(bar().textContent).toContain("第二条");
    expect(bar().textContent).not.toContain("第一条");

    await act(async () => vi.advanceTimersByTimeAsync(2_200));
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(bar().style.visibility).toBe("hidden");
  });

  it("熔断字幕立即打断并丢弃原队列", async () => {
    await emit(line("正在播报"));
    await emit(line("排队内容"));
    await emit(line("立即停止当前动作", "fuse", "安全闸门"));

    expect(bar().textContent).toContain("立即停止当前动作");
    expect(bar().textContent).not.toContain("正在播报");
    await act(async () => vi.advanceTimersByTimeAsync(4_500));
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(bar().textContent).not.toContain("排队内容");
  });

  it("隐藏态不通过位移制造视口外内容，长词允许在容器内断行", async () => {
    expect(bar().style.transform).toBe("translateX(-50%)");
    expect(bar().style.transform).not.toContain("translateY");
    expect(bar().getAttribute("aria-hidden")).toBe("true");

    await emit(line("verylongmachinetextwithoutbreakverylongmachinetextwithoutbreak", "ceremony", "超长播报员名称超长播报员名称"));
    const text = [...container.querySelectorAll("span")].find((item) => item.textContent?.includes("verylongmachine"));
    expect(text?.style.overflowWrap).toBe("anywhere");
    expect(text?.style.wordBreak).toBe("break-word");
  });

  it("卸载时注销订阅并清理当前计时器", async () => {
    await emit(line("等待卸载"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
