/** Reject incomplete/error bodies before they reach the browser or the shared cache. */
const MAX_WAV_BYTES = 32 * 1024 * 1024;
export function parseVoiceWav(bytes: Uint8Array): { format: Buffer; data: Buffer } {
  const wav = Buffer.from(bytes);
  if (wav.length < 44 || wav.length > MAX_WAV_BYTES || wav.toString("ascii", 0, 4) !== "RIFF"
    || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("invalid_voice_wav");
  let format: Buffer | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > wav.length) throw new Error("truncated_voice_wav");
    if (tag === "fmt ") format = wav.subarray(offset + 8, end);
    if (tag === "data") data = wav.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  if (!format || format.length < 16 || !data || data.length < 512 || offset !== wav.length) throw new Error("empty_voice_wav");
  const encoding = format.readUInt16LE(0), channels = format.readUInt16LE(2), rate = format.readUInt32LE(4), bits = format.readUInt16LE(14);
  const block = channels * bits / 8;
  if (![1, 3].includes(encoding) || channels < 1 || channels > 2 || rate < 8000 || rate > 96000
    || ![16, 24, 32].includes(bits) || (encoding === 3 && bits !== 32)
    || format.readUInt16LE(12) !== block || format.readUInt32LE(8) !== rate * block
    || data.length % block !== 0) throw new Error("unsupported_voice_wav");
  return { format, data };
}
/** Keep every chunk in order; never silently cut long speech at the model token limit. */
export function joinVoiceWavs(chunks: Uint8Array[], gapMs = 160): Uint8Array {
  if (!chunks.length) throw new Error("empty_voice_wav");
  const parsed = chunks.map(parseVoiceWav), format = parsed[0]!.format;
  if (parsed.some((chunk) => !chunk.format.equals(format))) throw new Error("incompatible_voice_wavs");
  const silence = Buffer.alloc(Math.round(format.readUInt32LE(4) * gapMs / 1000) * format.readUInt16LE(12));
  const pieces = parsed.flatMap((chunk, i) => i ? [silence, chunk.data] : [chunk.data]);
  const length = pieces.reduce((n, piece) => n + piece.length, 0), fmtPad = format.length % 2;
  const dataPad = length % 2;
  const total = 12 + 8 + format.length + fmtPad + 8 + length + dataPad;
  if (total > MAX_WAV_BYTES) throw new Error("voice_wav_too_large");
  const header = Buffer.alloc(12 + 8 + format.length + fmtPad + 8);
  header.write("RIFF", 0); header.writeUInt32LE(total - 8, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(format.length, 16); format.copy(header, 20);
  const dataOffset = 20 + format.length + fmtPad;
  header.write("data", dataOffset); header.writeUInt32LE(length, dataOffset + 4);
  return Buffer.concat([header, ...pieces, Buffer.alloc(dataPad)]);
}
export function splitVoiceText(text: string, limit = 80): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of Array.from(text)) {
    current += char;
    if (/[。！？!?；;\n]/u.test(char) || Array.from(current).length >= limit) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
