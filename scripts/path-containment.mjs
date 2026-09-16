import path from "node:path";

/**
 * 判断候选路径是否严格位于父目录内。
 * pathApi 可注入 win32/posix，确保发布门禁在三平台使用同一语义。
 */
export function isStrictPathWithin(parentPath, candidatePath, pathApi = path) {
  const parent = pathApi.resolve(parentPath);
  const candidate = pathApi.resolve(candidatePath);
  const relativePath = pathApi.relative(parent, candidate);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath);
}
