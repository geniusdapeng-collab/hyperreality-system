import { existsSync } from "node:fs";
import { join } from "node:path";

const CURRENT_WORKFLOW = ".github/workflows/desktop-production-release.yml";
const LEGACY_WORKFLOW = ".github/workflows/build-desktop.yml";

export function resolveDesktopWorkflowPath(repositoryRoot, product = {}) {
  const configured = String(product?.release?.workflow ?? "").trim();
  if (configured && (!configured.startsWith(".github/workflows/") || configured.includes(".."))) {
    throw new Error("产品清单 release.workflow 必须位于 .github/workflows/ 且不得越界");
  }
  const candidates = configured ? [configured] : [CURRENT_WORKFLOW, LEGACY_WORKFLOW];
  const relative = candidates.find((candidate) => existsSync(join(repositoryRoot, candidate))) ?? candidates[0];
  return { relative, absolute: join(repositoryRoot, relative), configured: Boolean(configured) };
}

export { CURRENT_WORKFLOW, LEGACY_WORKFLOW };
