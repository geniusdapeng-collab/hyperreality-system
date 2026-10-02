/** Capability discovery is metadata; availability needs independently readable evidence. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { verifyRun } from './delivery/evidence.mjs';

export function capabilityStatus({ root, id, discoverable = false, currentCommit, attestation, now = Date.now(), ttlMs = 90 * 86400000 } = {}) {
  const result = { discoverable: Boolean(discoverable), callable: 'unverified', verified: 'unverified', environment: null, lastSuccess: null, evidence: null, reason: '仅目录与入口元数据；没有对应运行证据' };
  if (!discoverable) return { ...result, reason: '入口未发现' };
  if (!attestation?.evidence || !root) return result;
  try {
    const proof = attestation.evidence;
    if (!/^[0-9a-f]{40}$/i.test(currentCommit ?? '') || proof.commit !== currentCommit) throw new Error('证据提交与当前源码不一致');
    if (!/^[0-9a-f]{64}$/i.test(proof.sha256 ?? '') || typeof proof.path !== 'string' || !proof.path || proof.path.includes('\\')) throw new Error('证据引用或散列无效');
    const base = realpathSync(root);
    const path = resolve(base, proof.path);
    const rel = relative(base, path);
    if (rel.startsWith('..' + sep) || rel === '..' || path === base) throw new Error('证据路径逃逸');
    let cursor = base;
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('证据路径不允许符号链接');
    }
    if (!lstatSync(path).isFile()) throw new Error('证据不是文件');
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== proof.sha256) throw new Error('证据散列不匹配');
    const value = JSON.parse(bytes.toString('utf8'));
    const run = verifyRun(attestation.run, { artifactRoot: base, repoRoot: base, commit: currentCommit, subject: { capabilityId: id }, requirePass: true });
    if (!run.ok) throw new Error(`运行证明无效：${run.errors.join('; ')}`);
    if (!(run.data.outputs ?? []).some(output => output.path === proof.path && output.sha256 === proof.sha256)) throw new Error('能力结果不属于本次执行输出');
    const at = Date.parse(value.completedAt);
    if (!Number.isFinite(at) || at > now + 60000 || now - at > ttlMs) throw new Error('证据时间无效或已过期');
    if (value.commit !== currentCommit || value.capabilityId !== id || value.exitCode !== 0) throw new Error('运行结果失败或归属不符');
    if (!['local-preview', 'client-runtime', 'deployed'].includes(value.environment)) throw new Error('运行环境未声明');
    if (value.callable !== true) throw new Error('运行记录未证明调用成功');
    if (value.verified === true && (run.data.role !== 'acceptance' || value.verifiedBy !== run.data.actor || !value.fixedBy || value.fixedBy === value.verifiedBy)) throw new Error('能力验收需要独立验证者及 acceptance 运行角色');
    return { ...result, callable: true, verified: value.verified === true, environment: value.environment, lastSuccess: value.completedAt, evidence: proof, reason: null };
  } catch (error) {
    return { ...result, reason: error.message };
  }
}
