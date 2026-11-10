import { strFromU8, Unzip, UnzipInflate, zipSync } from "fflate";

export type ArchiveLimits = { inputBytes: number; totalBytes: number; entryBytes: number; entries: number };
const defaults: ArchiveLimits = { inputBytes: 10 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, entries: 2000 };
const invalid = () => new Error("This Word archive is damaged or too complex to preview.");
type Entry = { name: string; flags: number; compression: number; compressed: number; expanded: number; crc: number; offset: number };
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function safeName(name: string) {
  const parts = name.split("/");
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 32 || code === 127) throw invalid();
  }
  if (!name || /[\\:]/.test(name) || name.startsWith("/") ||
    parts.some((part, index) => part === "." || part === ".." || !part && index !== parts.length - 1)) throw invalid();
}

// Validate the ZIP structure before decoding. Size declarations are only an
// early rejection: actual output is counted independently by the stream below.
function directory(bytes: Uint8Array, limits: ArchiveLimits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  for (; end >= earliest; end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < earliest || u16(end + 4) || u16(end + 6)) throw invalid();
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  if (!count || count > limits.entries || count !== u16(end + 8) || start + size !== end) throw invalid();
  const entries = new Map<string, Entry>();
  let offset = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalid();
    const flags = u16(offset + 8), compression = u16(offset + 10), compressed = u32(offset + 20), original = u32(offset + 24);
    const nameLength = u16(offset + 28), extraLength = u16(offset + 30), commentLength = u16(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    // DOCX archives never need encryption, split disks, ZIP64 or exotic codecs.
    if (next > end || flags & ~0x080e || ![0, 8].includes(compression) || u16(offset + 34) ||
      compressed > bytes.length || original > limits.entryBytes || (expanded += original) > limits.totalBytes) throw invalid();
    const name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength), !(flags & 0x0800));
    safeName(name);
    if (entries.has(name)) throw invalid();
    entries.set(name, { name, flags, compression, compressed, expanded: original, crc: u32(offset + 16), offset: u32(offset + 42) });
    offset = next;
  }
  if (offset !== end) throw invalid();

  // Every local entry must correspond exactly to one central entry. In
  // particular, do not let two entries alias bytes or hide trailing payloads.
  let nextLocal = 0;
  for (const entry of [...entries.values()].sort((a, b) => a.offset - b.offset)) {
    const local = entry.offset;
    if (local !== nextLocal || local + 30 > start || u32(local) !== 0x04034b50 ||
      u16(local + 6) !== entry.flags || u16(local + 8) !== entry.compression) throw invalid();
    const nameLength = u16(local + 26), data = local + 30 + nameLength + u16(local + 28);
    if (data > start || data + entry.compressed > start ||
      strFromU8(bytes.subarray(local + 30, local + 30 + nameLength), !(entry.flags & 0x0800)) !== entry.name) throw invalid();
    nextLocal = data + entry.compressed;
    if (entry.flags & 8) {
      if (nextLocal + 12 > start) throw invalid();
      if (u32(nextLocal) === 0x08074b50) nextLocal += 4;
      if (nextLocal + 12 > start || u32(nextLocal) !== entry.crc || u32(nextLocal + 4) !== entry.compressed || u32(nextLocal + 8) !== entry.expanded) throw invalid();
      nextLocal += 12;
    } else if (u32(local + 14) !== entry.crc || u32(local + 18) !== entry.compressed || u32(local + 22) !== entry.expanded) throw invalid();
  }
  if (nextLocal !== start) throw invalid();
  return { entries, start };
}

function rejectXmlDeclarations(name: string, data: Uint8Array) {
  if (!/\.(xml|rels)$/i.test(name)) return;
  const utf16 = data[0] === 0xff && data[1] === 0xfe || data[0] === 0x3c && data[1] === 0;
  const bigEndian = data[0] === 0xfe && data[1] === 0xff || data[0] === 0 && data[1] === 0x3c;
  const text = new TextDecoder(utf16 ? "utf-16le" : bigEndian ? "utf-16be" : "utf-8", { fatal: true }).decode(data);
  // Office XML has no DTD. Reject declarations before Mammoth's XML parser can
  // process internal entity expansion or external entity references.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw invalid();
}

/** Return an uncompressed ZIP containing only bounded, verified entry bytes. */
export function boundedDocxArchive(bytes: Uint8Array, overrides: Partial<ArchiveLimits> = {}): Uint8Array {
  const limits = { ...defaults, ...overrides };
  if (Object.keys(defaults).some(key => {
    const value = limits[key as keyof ArchiveLimits];
    return !Number.isSafeInteger(value) || value <= 0 || value > defaults[key as keyof ArchiveLimits];
  }) || bytes.length < 22 || bytes.length > limits.inputBytes) throw invalid();
  const { entries, start } = directory(bytes, limits);
  const files: Record<string, Uint8Array> = Object.create(null);
  const seen = new Set<string>();
  let expanded = 0, complete = 0;
  const unzip = new Unzip(file => {
    const entry = entries.get(file.name);
    if (!entry || seen.has(file.name) || file.compression !== entry.compression) throw invalid();
    seen.add(file.name);
    let length = 0, crc = 0xffffffff, finished = false;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, data, final) => {
      if (error || finished || !data) throw invalid();
      length += data.length;
      expanded += data.length;
      if (length > limits.entryBytes || expanded > limits.totalBytes) throw invalid();
      for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
      chunks.push(data);
      if (final) {
        finished = true;
        if (length !== entry.expanded || (crc ^ 0xffffffff) >>> 0 !== entry.crc) throw invalid();
        const content = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        rejectXmlDeclarations(file.name, content);
        files[file.name] = content;
        complete++;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Bound each decoder allocation by limiting compressed input per push.
  // Include only the central signature as an end marker, not its arbitrary
  // comments/extra fields, which the streaming decoder could mistake for files.
  const end = start + 4;
  for (let offset = 0; offset < end; offset += 1024) unzip.push(bytes.subarray(offset, Math.min(offset + 1024, end)), offset + 1024 >= end);
  if (seen.size !== entries.size || complete !== entries.size) throw invalid();
  // Mammoth receives these verified stored entries, never the original ZIP.
  return zipSync(files, { level: 0 });
}
