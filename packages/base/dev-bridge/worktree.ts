/**
 * git 隔离与快照（execFile 直调 git，不走 shell——注入面为零）
 * 纪律：机床只活在 worktree；基线分支永远不被机床直接写；
 *      会话前必留快照（基线 commit + status 指纹），失控可整棵丢弃。
 */
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface GitResult { stdout: string; stderr: string; code: number }

export function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code?: number }).code as number : 0;
      if (err && code === 0) { reject(err); return; }  // spawn 级失败（git 不存在等）
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} 失败：${r.stderr.trim().slice(0, 300)}`);
  return r.stdout.trim();
}

/** 校验路径确为 git 仓库（登记的仓库白名单前置检查） */
export async function assertGitRepo(repoPath: string): Promise<void> {
  await gitOk(["rev-parse", "--is-inside-work-tree"], repoPath);
}

export async function baselineCommit(repoPath: string, branch: string): Promise<string> {
  return gitOk(["rev-parse", branch], repoPath);
}

/** 快照指纹：status --porcelain 的哈希（回滚对照面） */
export async function statusFingerprint(repoPath: string): Promise<string> {
  const out = await gitOk(["status", "--porcelain=v2", "--branch"], repoPath);
  return createHash("sha1").update(out).digest("hex");
}

/** 建隔离 worktree：.workloom/<taskId>（仓内目录，便于相对路径与清理） */
export async function worktreeAdd(repoPath: string, taskId: string, baseBranch: string): Promise<{ worktreePath: string; branch: string }> {
  const branch = `dev/${taskId}`;
  const worktreePath = join(repoPath, ".workloom", taskId);
  await gitOk(["worktree", "add", worktreePath, "-b", branch, baseBranch], repoPath);
  return { worktreePath, branch };
}

/** 整棵丢弃（回滚/清理）：先强行移除 worktree，再删隔离分支 */
export async function worktreeDiscard(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await git(["worktree", "remove", "--force", worktreePath], repoPath).catch(() => undefined);
  await git(["branch", "-D", branch], repoPath).catch(() => undefined);
}

/** 变更回收：diff --stat + 逐文件增删 + 未跟踪清单（相对基线） */
export async function collectDiff(worktreePath: string, baseBranch: string): Promise<{
  diffStat: string;
  files: Array<{ path: string; added: number; deleted: number }>;
  untracked: string[];
}> {
  const diffStat = await git(["diff", "--stat", `${baseBranch}...HEAD`], worktreePath);
  // 机床可能未提交：把未提交改动也算进去（worktree 相对基线分支的全量差异）
  const dirty = await gitOk(["status", "--porcelain=v1"], worktreePath);
  // untracked 用 ls-files 逐文件展开（status 会把整目录折叠成 "src/"）
  const others = await git(["ls-files", "--others", "--exclude-standard"], worktreePath);
  const untracked = others.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  const numstat = await git(["diff", "--numstat", `${baseBranch}...HEAD`], worktreePath);
  const files = numstat.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [a, d, p] = l.split("\t");
    return { path: p ?? "", added: Number(a) || 0, deleted: Number(d) || 0 };
  });
  // 未提交的工作区改动并入统计（相对基线的 working tree diff）
  if (dirty.trim()) {
    const wtNumstat = await git(["diff", "--numstat", baseBranch], worktreePath);
    const seen = new Set(files.map((f) => f.path));
    for (const l of wtNumstat.stdout.trim().split("\n").filter(Boolean)) {
      const [a, d, p] = l.split("\t");
      if (p && !seen.has(p)) files.push({ path: p, added: Number(a) || 0, deleted: Number(d) || 0 });
    }
  }
  return { diffStat: diffStat.stdout.trim(), files, untracked };
}

/** 把隔离分支的工作区改动提交（合并前置：机床不一定自己提交） */
export async function commitWorktreeChanges(worktreePath: string, message: string, author = "WorkLoom DevFabric <devfabric@workloom.local>"): Promise<boolean> {
  const dirty = await gitOk(["status", "--porcelain=v1"], worktreePath);
  if (!dirty.trim()) return false;
  await gitOk(["add", "-A"], worktreePath);
  await gitOk(["-c", `user.name=${author.split(" <")[0]}`, "-c", `user.email=${author.match(/<(.+)>/)?.[1] ?? "devfabric@workloom.local"}`,
    "commit", "-m", message], worktreePath);
  return true;
}

/** 合并隔离分支回基线（在 repo 主工作区执行；冲突抛错转人工，绝不强合） */
export async function mergeIntoBaseline(repoPath: string, baseBranch: string, devBranch: string): Promise<string> {
  const current = (await gitOk(["branch", "--show-current"], repoPath)) || "HEAD";
  if (current !== baseBranch) await gitOk(["checkout", baseBranch], repoPath);
  const r = await git(["merge", "--no-ff", "-m", `merge: ${devBranch}（DevFabric 审批后发布）`, devBranch], repoPath);
  if (r.code !== 0) {
    await git(["merge", "--abort"], repoPath).catch(() => undefined);
    throw new Error(`合并冲突——已自动中止，转人工处理：${r.stderr.trim().slice(0, 300)}`);
  }
  return gitOk(["rev-parse", "HEAD"], repoPath);
}

export async function listTags(repoPath: string): Promise<string[]> {
  const out = await gitOk(["tag", "--list", "v*", "--sort=-v:refname"], repoPath).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function createTag(repoPath: string, tag: string, message: string): Promise<void> {
  await gitOk(["tag", "-a", tag, "-m", message], repoPath);
}

/** 探测仓库自带的质量关口脚本（S4 硬门禁：package.json scripts） */
export async function detectGateScripts(worktreePath: string): Promise<{ typecheck?: string; lint?: string; test?: string }> {
  const { existsSync, readFileSync } = await import("node:fs");
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const s = pkg.scripts ?? {};
    return {
      typecheck: s.typecheck ? "typecheck" : undefined,
      lint: s.lint ? "lint" : undefined,
      test: s.test ? "test" : undefined,
    };
  } catch { return {}; }
}

/** 临时目录（测试夹具用） */
export function tmpRepoDir(): string {
  return mkdtempSync(join(tmpdir(), "devfabric-"));
}
