/**
 * 织球 LoomBall · AI 班组状态表情球（React 封装）
 *
 * 定位纪律（不要误用）：它不是数字员工、不是视频能力、不替代织伴大形象；
 * 它是「工作状态指示灯」——用一只球把岗位/班组此刻在干什么变得看得见。
 *
 * 使用纪律：
 *  1. 一个挂载点一个实例；`emotion` 一律走 `agent-emotion.ts` 的映射层，业务方不传裸 ID；
 *  2. 列表默认 `live={false}`（引擎 `autostart:false` → `lite` 静态缩略图，零 rAF）；
 *     只有当前活跃项 / hover / focus 才激活动画（性能与注意力都省）；
 *  3. 球是装饰性元素（`aria-hidden`），语义由旁边的文字 chip 承担（`emotionLabelOf`）；
 *  4. `VITE_LOOMBALL=0` 时渲染等尺寸空盒：布局不跳、实例/监听/帧循环为零（一键回退；
 *     引擎模块本身仍随包加载，见 docs/loomball.md §5）。
 */
import { useEffect, useRef, useState } from "react";
import type { LoomBallEmotionId, LoomBallEngine } from "../../vendor/loomball";
import { ensureLoomBallEngine, loomBallApi, loomBallEnabled } from "./engine";
import { emotionLabelOf } from "./agent-emotion";

/**
 * 品牌皮肤：跟随 @workloom/ui 语义令牌（`--wl-brand-primary` / `--wl-brand-accent`），
 * 不在客户端硬编码品牌色——行业覆盖层只允许改 brand 标记的令牌，球体颜色因此自动随主题走；
 * 令牌取不到时返回空对象，交给上游引擎默认皮肤（不猜色）。
 */
export function loomBallBrandSkin(): { body?: string; eye?: string } {
  try {
    const styles = getComputedStyle(document.documentElement);
    const body = styles.getPropertyValue("--wl-brand-primary").trim();
    const eye = styles.getPropertyValue("--wl-brand-accent").trim();
    return { ...(body ? { body } : {}), ...(eye ? { eye } : {}) };
  } catch {
    return {};
  }
}

/** 小尺寸放大眼睛保证可读（48px 角标口径来自上游 SKILL） */
export function eyeScaleFor(size: number): number {
  if (size <= 56) return 1.4;
  if (size <= 96) return 1.25;
  return 1;
}

export interface LoomBallProps {
  emotion: LoomBallEmotionId;
  /** 直径（px），默认 48 */
  size?: number;
  /** 是否驱动动画；列表缩略图传 false（默认 true） */
  live?: boolean;
  /** 注视跟随（默认跟随 live） */
  followGaze?: boolean;
  /** 非 live 时，hover/focus 临时激活动画（名册默认开） */
  hoverActivate?: boolean;
  /** 眼环放大系数（默认按 size 推导） */
  eyeScale?: number;
  /** 悬停提示；默认取映射层文案 */
  title?: string;
  className?: string;
}

/** 尊重系统「减少动态效果」：开启时一律静态（不启动 rAF） */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function LoomBall(props: LoomBallProps) {
  const {
    emotion,
    size = 48,
    live = true,
    hoverActivate = !live,
    eyeScale,
    title,
    className,
  } = props;
  const followGaze = props.followGaze ?? live;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<LoomBallEngine | null>(null);
  const [hovered, setHovered] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const active = (live || (hoverActivate && hovered)) && !reducedMotion;
  const scale = eyeScale ?? eyeScaleFor(size);

  // 实例只建一次（size/emotion 变化走下面的 effect；StrictMode 双调用是安全的创建/销毁对）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !loomBallEnabled) return;
    const ready = ensureLoomBallEngine();
    if (!ready.enabled) return;
    const skin = loomBallBrandSkin();
    const engine = loomBallApi().create(host, {
      emotion,
      ...(skin.body ? { color: skin.body as `#${string}` } : {}),
      ...(skin.eye ? { eyeColor: skin.eye as `#${string}` } : {}),
      eyeScale: scale,
      autostart: active,
      idle: true,
    });
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初始值只取一次，后续变更走下面的 effect
  }, []);

  useEffect(() => {
    engineRef.current?.setEmotion(emotion);
  }, [emotion]);

  useEffect(() => {
    engineRef.current?.setActive(active);
  }, [active]);

  // 注视跟随：只有激活状态才挂监听（78 球同屏时最多 1 条监听）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !followGaze || !active) return;
    const onMove = (event: PointerEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      engine.setGaze(
        (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2),
        (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2),
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [followGaze, active]);

  const label = title ?? emotionLabelOf(emotion);
  const box = { width: size, height: size } as const;

  if (!loomBallEnabled) {
    // 回退态：等尺寸空盒（保持布局；旧形象由调用方保留）
    return <span className={className} style={box} aria-hidden="true" data-loomball="off" />;
  }

  return (
    <div
      className={className}
      style={{ ...box, position: "relative", flexShrink: 0 }}
      title={label}
      role="presentation"
      aria-hidden="true"
      data-loomball="on"
      data-loomball-emotion={String(emotion)}
      data-loomball-active={active ? "1" : "0"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      tabIndex={hoverActivate ? 0 : -1}
    >
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
