/** Machine-only Node TestsStream observer; file wrappers cannot replace real test counts. */
export default async function* report(source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== "test:summary") continue;
    if (event.data.file !== undefined) { files.set(event.data.file, event.data); continue; }
    // A completely filtered file can make Node's outer aggregate report passed=1.
    // Its own summary remains tests=0/passed=0, so prefer those actual file counts.
    const keys = ["tests", "passed", "failed", "cancelled", "skipped", "todo"];
    const counts = files.size ? [...files.values()].reduce((sum, file) => {
      for (const key of keys) sum[key] += file.counts[key];
      return sum;
    }, Object.fromEntries(keys.map((key) => [key, 0]))) : Object.fromEntries(keys.map((key) => [key, 0]));
    yield `${JSON.stringify({ schema: "workloom.node-test-summary/v1", aggregate: true, ...counts,
      files: files.size, success: files.size > 0 && event.data.success === true && [...files.values()].every((file) => file.success === true) })}\n`;
  }
}
