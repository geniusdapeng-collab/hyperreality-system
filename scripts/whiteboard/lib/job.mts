/**
 * 任务目录（唯一事实源，崩溃可恢复）——可移植版
 *
 * 渲染是分钟级长任务：进程重启/被 kill 之后必须知道"哪一幕已经渲完、合并到哪一步"，
 * 否则重跑会把已完成的幕重烧一遍。口径：`<outDir>/<filmId>/manifest.json` 是事实源。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kitEnv } from "./engine.mts";

export type SceneStatus = "pending" | "rendering" | "rendered" | "failed";
export type FilmStatus = "draft" | "narrated" | "planned" | "lineart" | "annotated" | "rendered" | "delivered" | "failed";

export interface SceneState {
  sceneNo: number; title: string; coreIdea: string;
  cueStartMs: number; cueEndMs: number; durationMs: number;
  lineartPath: string | null; lineartSource: string | null; lineartPrompt: string | null;
  lineartCheck: unknown; annotation: unknown; subtitleSrt: string;
  clipPath: string | null; status: SceneStatus; error: string | null;
}

export interface FilmManifest {
  schema: "workloom.whiteboard-film/v1";
  filmId: string; title: string; createdAt: string; updatedAt: string;
  status: FilmStatus;
  script: string; scriptSha256: string;
  narration: { profile: string; wavPath: string | null; durationMs: number | null; sentences: number; reused: number } | null;
  srt: string;
  scenes: SceneState[];
  finalPath: string | null;
  error: string | null;
  stages: Array<{ stage: string; ms: number; ok: boolean; detail?: string }>;
}

export function filmDir(filmId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(kitEnv(env).outDir, filmId);
}

export function manifestPath(filmId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(filmDir(filmId, env), "manifest.json");
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON */
export function writeManifest(manifest: FilmManifest, env: NodeJS.ProcessEnv = process.env): void {
  const dir = filmDir(manifest.filmId, env);
  mkdirSync(dir, { recursive: true });
  const target = manifestPath(manifest.filmId, env);
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(`${target}.tmp`, target);
}

export function readManifest(filmId: string, env: NodeJS.ProcessEnv = process.env): FilmManifest | null {
  const path = manifestPath(filmId, env);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FilmManifest;
  } catch {
    return null;
  }
}

/** 已渲染且产物仍在的幕 → 跳过重渲 */
export function resumableScene(scene: SceneState): boolean {
  return scene.status === "rendered" && Boolean(scene.clipPath) && existsSync(scene.clipPath!);
}

export function newFilmId(title: string, at = new Date()): string {
  const slug = title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 24) || "film";
  const stamp = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `WB-${stamp}-${slug}`;
}
