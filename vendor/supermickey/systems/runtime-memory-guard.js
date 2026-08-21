'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function parseBytes(val) {
  if (!val || val === 'max') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function readCgroupInfo() {
  const candidates = [
    {
      memoryMax: '/sys/fs/cgroup/memory.max',
      memoryCurrent: '/sys/fs/cgroup/memory.current',
      memoryEvents: '/sys/fs/cgroup/memory.events',
    },
    {
      memoryMax: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
      memoryCurrent: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      memoryEvents: '/sys/fs/cgroup/memory/memory.failcnt',
    },
  ];

  for (const c of candidates) {
    const max = readFileSafe(c.memoryMax);
    const current = readFileSafe(c.memoryCurrent);
    const events = readFileSafe(c.memoryEvents);

    if (max !== null || current !== null || events !== null) {
      return {
        memoryLimitBytes: parseBytes(max),
        memoryCurrentBytes: parseBytes(current),
        memoryEvents: events,
      };
    }
  }

  return {
    memoryLimitBytes: null,
    memoryCurrentBytes: null,
    memoryEvents: null,
  };
}

function snapshotMemory(tag = 'snapshot', extra = {}) {
  const mu = process.memoryUsage();
  const hs = v8.getHeapStatistics();
  const cg = readCgroupInfo();

  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    tag,
    rssMB: +(mu.rss / 1024 / 1024).toFixed(1),
    heapTotalMB: +(mu.heapTotal / 1024 / 1024).toFixed(1),
    heapUsedMB: +(mu.heapUsed / 1024 / 1024).toFixed(1),
    externalMB: +(mu.external / 1024 / 1024).toFixed(1),
    arrayBuffersMB: +((mu.arrayBuffers || 0) / 1024 / 1024).toFixed(1),
    heapLimitMB: +(hs.heap_size_limit / 1024 / 1024).toFixed(1),
    cgroupLimitMB: cg.memoryLimitBytes ? +(cg.memoryLimitBytes / 1024 / 1024).toFixed(1) : null,
    cgroupCurrentMB: cg.memoryCurrentBytes ? +(cg.memoryCurrentBytes / 1024 / 1024).toFixed(1) : null,
    cgroupEvents: cg.memoryEvents,
    loadavg: os.loadavg(),
    uptimeSec: +process.uptime().toFixed(1),
    ...extra,
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function dumpMemoryToFile(tag = 'snapshot', extra = {}, file = './output/memory-snapshots.log') {
  const snap = snapshotMemory(tag, extra);
  ensureDir(file);
  fs.appendFileSync(file, JSON.stringify(snap) + '\n', 'utf8');
  return snap;
}

function logMemory(tag = 'snapshot', extra = {}) {
  const snap = snapshotMemory(tag, extra);
  console.log(`[MEM] ${JSON.stringify(snap)}`);
  return snap;
}

async function memoryReliefPoint(tag = 'point', extra = {}) {
  logMemory(tag, extra);
  dumpMemoryToFile(tag, extra, './output/memory-snapshots.log');

  await new Promise((r) => setTimeout(r, 10));

  if (global.gc) {
    try {
      global.gc();
      await new Promise((r) => setTimeout(r, 10));
      logMemory(`${tag}:after-gc`, extra);
    } catch (e) {
      console.warn(`[GC] failed at ${tag}:`, e.message);
    }
  }
}

module.exports = {
  readCgroupInfo,
  snapshotMemory,
  dumpMemoryToFile,
  logMemory,
  memoryReliefPoint,
};
