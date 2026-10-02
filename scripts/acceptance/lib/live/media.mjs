/** Local media delivery proof: bounded download, format, decoder, real path and SHA-256. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadChromium } from "../playwright.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const LIMITS = { image: 64 * 1024 * 1024, video: 256 * 1024 * 1024 };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (message, code = "MEDIA_INVALID") => Object.assign(new Error(message), { code });

export function assertSafeTaskId(id) {
  if (typeof id !== "string" || id.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id.includes("..")) {
    throw failure("任务 ID 必须是安全的文件名，不能包含路径或上级目录");
  }
  return id;
}

export function publicArtifactUrl(value) {
  try {
    const url = new URL(value);
    return url.origin !== "null" ? `${url.origin}${url.pathname}` : `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return "(invalid artifact URL)"; }
}

function artifactRoot(dir) {
  if (!dir) throw failure("没有声明本地产物目录");
  const absolute = resolve(dir);
  mkdirSync(absolute, { recursive: true });
  if (lstatSync(absolute).isSymbolicLink()) throw failure("产物目录不能是符号链接");
  return realpathSync(absolute);
}

function inside(root, path) {
  const rel = relative(root, path);
  return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

/** Read through an O_NOFOLLOW file descriptor, then prove the path still names that file. */
function localBytes(path, dir, kind) {
  const root = artifactRoot(dir);
  if (typeof path !== "string" || /^https?:/iu.test(path)) throw failure("远端 URL 不能作为本地交付物");
  const absolute = resolve(path);
  // macOS /var is a system alias for /private/var; allow the declared lexical root,
  // then prove containment through realpath before opening the file.
  if (!inside(root, absolute) && !inside(resolve(dir), absolute)) throw failure("产物路径超出声明目录");
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure("产物必须是独立的普通文件，不能是链接或目录");
  if ((stat.mode & 0o444) === 0) throw failure("产物文件没有读取权限");
  if (!inside(root, realpathSync(absolute))) throw failure("产物真实路径逃逸");
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = fstatSync(fd);
    if (!held.isFile() || held.size <= 0 || held.size > LIMITS[kind]) throw failure("产物为空或超过本地校验大小上限");
    const bytes = readFileSync(fd);
    const after = lstatSync(absolute);
    if (after.ino !== held.ino || after.dev !== held.dev || after.isSymbolicLink() || bytes.length !== held.size || !inside(root, realpathSync(absolute))) {
      throw failure("产物在校验期间发生替换或路径变化");
    }
    return { bytes, absolute: realpathSync(absolute) };
  } finally { closeSync(fd); }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
  let offset = 8;
  let count = 0;
  let imageData = false;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw failure("PNG 数据块被截断");
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) throw failure("PNG 数据块长度错误");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw failure("PNG 校验和错误");
    if (count === 0 && (type !== "IHDR" || length !== 13)) throw failure("PNG 缺少有效 IHDR");
    if (type === "IDAT" && length > 0) imageData = true;
    if (type === "IEND") {
      if (length !== 0 || offset + 12 !== bytes.length) throw failure("PNG 结束块或尾部数据错误");
      ended = true;
    }
    offset += 12 + length;
    count += 1;
  }
  if (!imageData || !ended) throw failure("PNG 缺少图像数据或结束块");
  return { format: "png", mime: "image/png" };
}

function boxes(bytes, start = 0, end = bytes.length) {
  const found = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw failure("MP4 容器被截断");
    let size = bytes.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw failure("MP4 扩展长度被截断");
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("MP4 容器长度无效");
      size = Number(large);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw failure("MP4 容器长度错误");
    found.push({ type: bytes.toString("ascii", offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return found;
}

function mediaFormat(bytes, kind) {
  if (kind === "image") {
    if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return png(bytes);
    if (bytes.length > 32 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) return { format: "jpg", mime: "image/jpeg" };
    if (bytes.length > 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) return { format: "webp", mime: "image/webp" };
    throw failure("内容不是完整的 PNG/JPEG/WebP 图片");
  }
  if (kind !== "video") throw failure("未知媒体模态");
  const top = boxes(bytes);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat" && b.end > b.start);
  if (!ftyp || ftyp.end - ftyp.start < 8 || !moov || !mdat) throw failure("MP4 缺少文件类型、元数据或媒体数据");
  const tracks = boxes(bytes, moov.start, moov.end).filter((b) => b.type === "trak");
  const videoTrack = tracks.some((track) => {
    const mdia = boxes(bytes, track.start, track.end).find((b) => b.type === "mdia");
    if (!mdia) return false;
    const handler = boxes(bytes, mdia.start, mdia.end).find((b) => b.type === "hdlr");
    return handler && handler.end - handler.start >= 12 && bytes.toString("ascii", handler.start + 8, handler.start + 12) === "vide";
  });
  if (!videoTrack) throw failure("MP4 不包含有效视频轨道");
  return { format: "mp4", mime: "video/mp4" };
}

/** Decode local bytes in an isolated, network-blocked browser. A header alone is never proof. */
async function decode(bytes, { kind, mime, repoRoot = REPO_ROOT, timeoutMs = 30_000 }) {
  let browser;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TEMP|TMP|SystemRoot|WINDIR|LOCALAPPDATA|DISPLAY|LANG|LC_.*|PLAYWRIGHT_BROWSERS_PATH)$/u.test(key)));
  try {
    const chromium = loadChromium(repoRoot);
    try { browser = await chromium.launch({ env }); }
    catch (error) {
      // Branded Chrome is supported by Playwright and supplies proprietary media codecs.
      // Both launches use a fresh temporary profile; neither touches an active browser session.
      try { browser = await chromium.launch({ channel: "chrome", env }); }
      catch { throw failure(`本地媒体解码器不可用：${String(error.message).split("\n")[0]}`, "MEDIA_VERIFIER_UNAVAILABLE"); }
    }
  } catch (error) {
    if (error.code) throw error;
    throw failure("本地媒体解码器不可用，不能验证交付物", "MEDIA_VERIFIER_UNAVAILABLE");
  }
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    return await page.evaluate(async ({ base64, mime, kind, timeoutMs }) => {
      const raw = atob(base64);
      const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      let media;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          const fail = (message) => reject(new Error(message));
          timer = setTimeout(() => fail("本地媒体解码超时"), timeoutMs);
          if (kind === "image") {
            media = new Image();
            media.onerror = () => fail("图片内容无法解码");
            media.onload = () => {
              const width = media.naturalWidth;
              const height = media.naturalHeight;
              if (!width || !height || width * height > 100_000_000) return fail("图片尺寸无效或超出校验上限");
              const canvas = document.createElement("canvas");
              canvas.width = 1;
              canvas.height = 1;
              canvas.getContext("2d").drawImage(media, 0, 0, 1, 1);
              canvas.getContext("2d").getImageData(0, 0, 1, 1);
              resolve({ width, height, decoded: true, decoder: "browser" });
            };
            media.src = url;
          } else {
            media = document.createElement("video");
            media.muted = true;
            media.playsInline = true;
            let frames = 0;
            const onFrame = () => { frames += 1; if (!media.ended) media.requestVideoFrameCallback(onFrame); };
            media.onerror = () => fail("视频内容无法解码");
            media.onloadeddata = async () => {
              if (!Number.isFinite(media.duration) || media.duration <= 0 || !media.videoWidth || !media.videoHeight) return fail("视频时长/画面无效");
              media.requestVideoFrameCallback(onFrame);
              media.playbackRate = 8;
              try { await media.play(); } catch { fail("视频不能播放"); }
            };
            media.onended = () => {
              if (frames === 0) return fail("视频没有可解码画面");
              resolve({ width: media.videoWidth, height: media.videoHeight, durationSeconds: media.duration, decodedFrames: frames, decoded: true, decoder: "browser" });
            };
            media.src = url;
            media.load();
          }
        });
      } finally {
        clearTimeout(timer);
        if (kind === "video" && media) { media.pause(); media.removeAttribute("src"); media.load(); }
        URL.revokeObjectURL(url);
      }
    }, { base64: bytes.toString("base64"), mime, kind, timeoutMs });
  } finally { await browser.close(); }
}

export async function inspectLocalArtifact({ path, artifactsDir, kind, timeoutMs, repoRoot }) {
  const read = localBytes(path, artifactsDir, kind);
  const format = mediaFormat(read.bytes, kind);
  const content = await decode(read.bytes, { ...format, kind, timeoutMs, repoRoot });
  const reread = localBytes(path, artifactsDir, kind);
  const sha256 = hash(read.bytes);
  if (hash(reread.bytes) !== sha256) throw failure("媒体在解码期间发生变化");
  return { path: read.absolute, bytes: read.bytes.length, sha256, ...format, ...content };
}

async function responseBytes(response, limit) {
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (length > limit) throw failure("下载体超过媒体大小上限");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw failure("下载体超过媒体大小上限");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw failure("下载体超过媒体大小上限");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (length > 0 && length !== size) throw failure("下载长度与响应头不一致");
  return Buffer.concat(chunks, size);
}

export async function downloadArtifact({ url, artifactsDir, taskId, index = 1, kind, timeoutMs = 180_000, repoRoot }) {
  let temp;
  try {
    assertSafeTaskId(taskId);
    if (!LIMITS[kind] || !Number.isSafeInteger(index) || index <= 0) throw failure("媒体下载参数无效");
    const remote = new URL(url);
    if (!["http:", "https:"].includes(remote.protocol) || remote.username || remote.password) throw failure("媒体 URL 不是无凭据的 HTTP(S) 地址");
    const root = artifactRoot(artifactsDir);
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(180_000, timeoutMs))) });
    if (!response.ok) throw failure(`媒体下载 HTTP ${response.status}`);
    const bytes = await responseBytes(response, LIMITS[kind]);
    if (!bytes.length) throw failure("媒体下载返回零字节");
    const format = mediaFormat(bytes, kind);
    const declaredMime = response.headers?.get?.("content-type")?.split(";")[0]?.trim();
    if (declaredMime?.startsWith(kind === "image" ? "image/" : "video/") && declaredMime !== format.mime) throw failure("媒体内容格式与 HTTP 类型不一致");
    const id = randomUUID();
    temp = join(root, `.media-${id}.part`);
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    const inspected = await inspectLocalArtifact({ path: temp, artifactsDir: root, kind, timeoutMs: Math.min(timeoutMs, 30_000), repoRoot });
    const path = join(root, `${taskId}-${index}-${id}.${format.format}`);
    if (existsSync(path) || basename(path).includes("..")) throw failure("产物文件名冲突");
    if (realpathSync(root) !== root) throw failure("产物目录在下载期间被替换");
    renameSync(temp, path);
    temp = null;
    const landed = localBytes(path, root, kind);
    if (hash(landed.bytes) !== inspected.sha256) throw failure("媒体落盘后散列不一致");
    return { ok: true, artifact: { ...inspected, path, url: publicArtifactUrl(url) } };
  } catch (error) {
    return { ok: false, status: error.code === "MEDIA_VERIFIER_UNAVAILABLE" ? "blocked" : "failed", reason: String(error.message ?? "媒体校验失败").slice(0, 240) };
  } finally { if (temp) rmSync(temp, { force: true }); }
}

/** Check both manifests against fresh file/decoder results; missing digests or URL-only entries fail. */
export async function verifyArtifactReceipts({ artifacts = [], receipt, artifactsDir, kind }) {
  const problems = [];
  const verified = [];
  const manifest = receipt?.artifacts;
  if (!Array.isArray(manifest) || !manifest.length) return { ok: false, problems: ["回执缺少本地产物清单"], verified };
  if (artifacts.length !== manifest.length) problems.push("产物与回执清单数量不一致");
  const paths = new Set();
  for (const artifact of artifacts) {
    try {
      if (!artifact.path || paths.has(artifact.path)) throw failure("媒体路径缺失或重复");
      paths.add(artifact.path);
      const actual = await inspectLocalArtifact({ path: artifact.path, artifactsDir, kind });
      const expected = manifest.find((item) => item.path === artifact.path);
      if (!expected || ["bytes", "sha256", "format", "mime"].some((key) => artifact[key] !== actual[key] || expected[key] !== actual[key])) {
        throw failure("本地产物大小/格式/散列与回执不一致");
      }
      if (kind === "video" && [artifact, expected].some((item) => !Number.isFinite(item.durationSeconds) || Math.abs(item.durationSeconds - actual.durationSeconds) > 0.01)) throw failure("视频真实时长与回执不一致");
      verified.push(actual);
    } catch (error) { problems.push(String(error.message ?? "产物不可读").slice(0, 240)); }
  }
  return { ok: problems.length === 0 && verified.length > 0, problems, verified };
}
