#!/usr/bin/env tsx
/**
 * 手绘白板解说片 · 一条命令出片（可移植版）
 *
 *   口播稿 → 配音 → SRT → 分幕 → 逐幕线稿 → 逐幕标注 → 确认关预览 → 逐幕渲染 → 合并 → 混流 → 成片
 *
 * 设计要点：
 *   · **零仓内依赖**：只用 Node 内置模块 + 本目录的 Python 引擎脚本；不要求宿主仓有视频子系统
 *     （render_jobs / 媒资库 / gen 接缝），因此可以被复制到舰队任何一个仓独立运行；
 *   · **确定性**：分句 / 分幕 / 区域反推 / 时序全由代码算，同一份稿子每次得到同一部片子；
 *   · **断点续跑**：任务目录 `manifest.json` 是事实源，已渲完的幕跳过、配音逐句按文本哈希复用；
 *   · **不静默**：每一步失败都带原因（子进程 stdout/stderr 尾部）；
 *   · **零模型成本**（线稿选 sketch / upload 时）。
 *
 * 用法（任意仓内）：
 *   pnpm exec tsx scripts/whiteboard/film.mts --script <口播稿.md> --title "标题" \
 *     [--lineart seedream|sketch|upload] [--source <图>] [--profile chen-zhuo-film] \
 *     [--target-sec 26] [--min-sec 18] [--max-sec 34] [--fps 30] [--cap-long-edge 1280] \
 *     [--srt <外部.srt>] [--audio <外部配音.wav>] [--only 环节,环节] [--film <filmId>] [--evidence <json>]
 *
 * 环节名：narrate, plan, lineart, annotate, preview, render, deliver（默认全跑）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { engineHint, engineReady, kitEnv, mergeScenes, renderAnnotationPreview, renderScene } from "./lib/engine.mts";
import { buildLineart } from "./lib/lineart.mts";
import { buildAnnotation, writeAnnotation } from "./lib/annotate.mts";
import { muxFilm } from "./lib/mux.mts";
import { buildSceneSrt, groupScenes, parseSrt, tileScenes } from "./lib/srt.mts";
import { synthesizeNarration, voiceStationHealth } from "./lib/voice.mts";
import {
  filmDir, newFilmId, readManifest, resumableScene, writeManifest,
  type FilmManifest, type SceneState,
} from "./lib/job.mts";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const flag = (name: string) => process.argv.includes(name);
const num = (name: string, fallback: number) => (arg(name) ? Number(arg(name)) : fallback);

const started = Date.now();
const stages: FilmManifest["stages"] = [];

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    stages.push({ stage: name, ms: Date.now() - t0, ok: true });
    console.log(`✓ ${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = (err as { detail?: string }).detail ?? "";
    stages.push({ stage: name, ms: Date.now() - t0, ok: false, detail: `${message}${detail ? `｜${detail}` : ""}`.slice(0, 600) });
    console.error(`✗ ${name}：${message}${detail ? `\n   ${detail}` : ""}`);
    throw err;
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const scriptPath = arg("--script");
  const externalSrt = arg("--srt");
  const externalAudio = arg("--audio");
  if (!scriptPath && !externalSrt) throw new Error("至少要给 --script（口播稿）或 --srt（已有字幕）");
  if (!engineReady(env)) throw new Error(`白板引擎未就绪：${engineHint(env)}`);

  const script = scriptPath ? readFileSync(resolve(scriptPath), "utf8") : "";
  const title = arg("--title", scriptPath ? basename(scriptPath).replace(/\.[^.]+$/, "") : "手绘白板解说片");
  const filmId = arg("--film") || newFilmId(title);
  const dir = filmDir(filmId, env);
  mkdirSync(dir, { recursive: true });

  let manifest: FilmManifest = readManifest(filmId, env) ?? {
    schema: "workloom.whiteboard-film/v1",
    filmId, title,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: "draft",
    script,
    scriptSha256: createHash("sha256").update(script).digest("hex"),
    narration: null, srt: "", scenes: [], finalPath: null, error: null, stages,
  };
  manifest.title = title;
  manifest.stages = stages;
  const save = () => writeManifest(manifest, env);
  save();

  const only = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
  const wants = (name: string) => only.length === 0 || only.includes(name);

  console.log(`\n白板片 ${filmId}｜${title}`);
  console.log(`任务目录：${dir}\n`);

  /* ---------- ① 配音 + SRT（或采用外部 SRT / 配音） ---------- */
  if (wants("narrate") && !manifest.narration) {
    if (externalSrt) {
      const srtText = readFileSync(resolve(externalSrt), "utf8");
      manifest.srt = srtText;
      manifest.narration = { profile: "external", wavPath: externalAudio ? resolve(externalAudio) : null,
        durationMs: null, sentences: parseSrt(srtText).length, reused: 0 };
      manifest.status = "narrated";
      save();
      stages.push({ stage: "narrate(external-srt)", ms: 0, ok: true });
      console.log(`✓ narrate（外部 SRT：${manifest.narration.sentences} 条${externalAudio ? " + 外部配音" : ""}）`);
    } else {
      const health = await voiceStationHealth(env);
      console.log(`  配音工位：${health.detail}`);
      await stage("narrate", async () => {
        const narration = await synthesizeNarration({
          script, outDir: dir, env,
          onProgress: (done, total, current) => console.log(`  配音进度 ${done}/${total}：${current.slice(0, 26)}`),
        });
        manifest.srt = narration.srt;
        manifest.narration = {
          profile: narration.profile, wavPath: narration.wavPath, durationMs: narration.totalMs,
          sentences: narration.cues.length, reused: narration.reused,
        };
        manifest.status = "narrated";
        save();
      });
    }
  }

  /* ---------- ② 分幕 ---------- */
  if (wants("plan") && manifest.scenes.length === 0) {
    await stage("plan", async () => {
      const cues = parseSrt(manifest.srt);
      if (cues.length === 0) throw new Error("没有可用的 SRT：请先跑 narrate，或提供 --srt");
      const totalMs = manifest.narration?.durationMs ?? cues[cues.length - 1]!.endMs;
      const scenes = tileScenes(groupScenes(cues, {
        targetSec: num("--target-sec", 26), minSec: num("--min-sec", 18), maxSec: num("--max-sec", 34),
      }), totalMs);
      manifest.scenes = scenes.map((scene) => {
        const sceneCues = cues.filter((c) => c.index >= scene.cueRange[0] && c.index <= scene.cueRange[1]);
        const state: SceneState = {
          sceneNo: scene.sceneIndex, title: `第 ${scene.sceneIndex} 幕`, coreIdea: scene.text.slice(0, 200),
          cueStartMs: scene.startMs, cueEndMs: scene.endMs, durationMs: scene.sceneDurationMs,
          lineartPath: null, lineartSource: null, lineartPrompt: null, lineartCheck: null,
          annotation: null, subtitleSrt: buildSceneSrt(sceneCues), clipPath: null, status: "pending", error: null,
        };
        return state;
      });
      manifest.status = "planned";
      save();
      console.log(`  ${manifest.scenes.length} 幕 / ${(totalMs / 1000).toFixed(1)}s`);
    });
  }

  /* ---------- ③ 逐幕线稿（默认跳过已有线稿，不重烧出图费） ---------- */
  if (wants("lineart")) {
    const sceneNo = arg("--scene");
    const targets = sceneNo ? manifest.scenes.filter((s) => s.sceneNo === Number(sceneNo)) : manifest.scenes;
    for (const scene of targets) {
      if (scene.lineartPath && !flag("--force-lineart")) continue;
      await stage(`lineart:${scene.sceneNo}`, async () => {
        const result = await buildLineart({
          sceneNo: scene.sceneNo, jobDir: dir, coreIdea: scene.coreIdea,
          elements: scene.subtitleSrt.split(/\r?\n/).filter((l) => l && !/^\d+$/.test(l) && !l.includes("-->")),
          mode: (arg("--lineart", "seedream") as "seedream" | "sketch" | "upload"),
          sourcePath: arg("--source") || undefined, env,
        });
        scene.lineartPath = result.absPath;
        scene.lineartSource = result.source;
        scene.lineartPrompt = result.prompt;
        scene.lineartCheck = result.check;
        scene.status = "pending";
        manifest.status = "lineart";
        save();
      });
    }
  }

  /* ---------- ④ 逐幕标注 ---------- */
  if (wants("annotate")) {
    const sceneNo = arg("--scene");
    const targets = sceneNo ? manifest.scenes.filter((s) => s.sceneNo === Number(sceneNo)) : manifest.scenes;
    for (const scene of targets) {
      if (!scene.lineartPath) throw new Error(`第 ${scene.sceneNo} 幕还没有线稿（先跑 lineart）`);
      await stage(`annotate:${scene.sceneNo}`, async () => {
        const built = await buildAnnotation({
          sceneNo: scene.sceneNo, sceneTitle: scene.title,
          cues: parseSrt(scene.subtitleSrt), lineartAbsPath: scene.lineartPath!,
          sceneDurationMs: scene.durationMs, env,
        });
        writeAnnotation(dir, scene.sceneNo, built.annotation);
        scene.annotation = built.annotation;
        scene.status = "pending";
        manifest.status = "annotated";
        save();
        if (built.problems.length > 0) console.log(`   ⚠ 第 ${scene.sceneNo} 幕契约问题 ${built.problems.length} 项：${built.problems[0]}`);
      });
    }
  }

  /* ---------- ⑤ 确认关预览（可跳过；--skip-preview） ---------- */
  if (wants("preview") && !flag("--skip-preview")) {
    for (const scene of manifest.scenes) {
      if (!scene.lineartPath || !scene.annotation) continue;
      await stage(`preview:${scene.sceneNo}`, async () => {
        const annotationPath = writeAnnotation(dir, scene.sceneNo, scene.annotation as never);
        await renderAnnotationPreview(scene.lineartPath!, annotationPath,
          `${dir}/scene-${String(scene.sceneNo).padStart(2, "0")}.preview.png`, env);
      });
    }
  } else if (wants("preview")) {
    stages.push({ stage: "preview", ms: 0, ok: true, detail: "自动模式跳过（--skip-preview 显式留痕）" });
    console.log("· preview 跳过（--skip-preview）");
  }

  /* ---------- ⑥ 逐幕渲染 + 合并 ---------- */
  if (wants("render")) {
    for (const scene of manifest.scenes) {
      if (resumableScene(scene)) continue;
      await stage(`render:${scene.sceneNo}`, async () => {
        if (!scene.lineartPath || !scene.annotation) throw new Error(`第 ${scene.sceneNo} 幕缺线稿或标注`);
        const annotationPath = writeAnnotation(dir, scene.sceneNo, scene.annotation as never);
        const output = `${dir}/scene-${String(scene.sceneNo).padStart(2, "0")}.mp4`;
        const rendered = await renderScene({
          imagePath: scene.lineartPath!, annotationPath, outputPath: output,
          fps: num("--fps", Number(env.WHITEBOARD_FPS ?? 30)),
          capLongEdge: num("--cap-long-edge", Number(env.WHITEBOARD_CAP_LONG_EDGE ?? 1280)),
          totalMs: scene.durationMs, env,
        });
        scene.clipPath = rendered.outputPath;
        scene.status = "rendered";
        scene.error = null;
        save();
      });
    }
    const clips = manifest.scenes.map((s) => s.clipPath).filter(Boolean) as string[];
    if (clips.length !== manifest.scenes.length) throw new Error(`还有 ${manifest.scenes.length - clips.length} 幕没有渲完`);
    const silent = clips.length > 1
      ? await stage("merge", () => mergeScenes(clips, `${dir}/whiteboard-silent.mp4`, env))
      : clips[0]!;
    manifest.finalPath = silent;
    manifest.status = "rendered";
    save();
  }

  /* ---------- ⑦ 交付（混流 + 软字幕） ---------- */
  if (wants("deliver")) {
    await stage("deliver", async () => {
      const silent = manifest.finalPath;
      if (!silent || !existsSync(silent)) throw new Error("没有可混流的无声成片（先跑 render）");
      const narrationWav = manifest.narration?.wavPath;
      const srtPath = `${dir}/film.srt`;
      writeFileSync(srtPath, manifest.srt, "utf8");
      if (!narrationWav || !existsSync(narrationWav)) {
        // 没有配音轨（外部 SRT 模式）→ 只出无声母版 + 字幕旁挂，明确标注
        const { copyFileSync } = await import("node:fs");
        const out = `${dir}/whiteboard-final.mp4`;
        copyFileSync(silent, out);
        manifest.finalPath = out;
        console.log("   ⚠ 无配音轨：交付的是无声母版 + 字幕旁挂（film.srt）");
      } else {
        const out = `${dir}/whiteboard-final.mp4`;
        const mux = await muxFilm({
          silentVideo: silent, narrationWav, output: out, srtPath,
          targetLufs: Number(env.WHITEBOARD_VOICE_LUFS ?? "-16"), env,
        });
        manifest.finalPath = out;
        console.log(`   响度 ${mux.loudnessBefore?.toFixed(2)} → ${mux.loudnessAfter?.toFixed(2)} LUFS；`
          + `音画漂移 ${mux.avDriftSec}s；成片 ${mux.videoSeconds.toFixed(2)}s`);
      }
      manifest.status = "delivered";
      save();
    });
  }

  manifest.stages = stages;
  writeManifest(manifest, env);

  const evidence = {
    task: arg("--task", "whiteboard-kit"),
    film: { id: filmId, title, status: manifest.status, dir },
    script: { chars: script.length, sha256: manifest.scriptSha256 },
    narration: manifest.narration,
    srt: { lines: manifest.srt.split("\n").filter((l) => l.includes("-->")).length },
    scenes: manifest.scenes.map((s) => ({
      sceneNo: s.sceneNo, durationMs: s.durationMs, lineartSource: s.lineartSource,
      lineartCheckOk: (s.lineartCheck as { ok?: boolean } | null)?.ok ?? null,
      elements: (s.annotation as { elements?: unknown[] } | null)?.elements?.length ?? 0,
      clip: s.clipPath, status: s.status,
    })),
    finalPath: manifest.finalPath,
    stages,
    totalMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
  const evidencePath = resolve(arg("--evidence", `${dir}/evidence.json`));
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`\n成片：${manifest.finalPath}`);
  console.log(`证据：${evidencePath}`);
  console.log(`总耗时：${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`\n[失败] ${err instanceof Error ? err.message : String(err)}`);
  if ((err as { detail?: string }).detail) console.error(`   ${(err as { detail?: string }).detail}`);
  process.exit(1);
});
