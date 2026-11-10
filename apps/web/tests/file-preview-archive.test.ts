import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, unzipSync, Zip, ZipDeflate, zipSync } from "fflate";
import { boundedDocxArchive } from "../src/file-preview/docx-archive";

const xml = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello, café.</w:t></w:r></w:p></w:body></w:document>');
const office = () => zipSync({ "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), "word/": new Uint8Array(), "word/document.xml": xml });
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function entries(bytes: Uint8Array) {
  const data = view(bytes), end = bytes.length - 22;
  let offset = data.getUint32(end + 16, true);
  const result: { central: number; local: number }[] = [];
  for (let index = 0; index < data.getUint16(end + 10, true); index++) {
    result.push({ central: offset, local: data.getUint32(offset + 42, true) });
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
  }
  return result;
}
function forgeExpandedSizes(bytes: Uint8Array, size: number) {
  const data = view(bytes);
  for (const entry of entries(bytes)) {
    data.setUint32(entry.local + 22, size, true);
    data.setUint32(entry.central + 24, size, true);
  }
  return bytes;
}

test("valid Office entries are verified and repackaged without compression or changed content", () => {
  const original = office(), safe = boundedDocxArchive(original);
  assert.deepEqual(unzipSync(safe), unzipSync(original));
  for (const entry of entries(safe)) assert.equal(view(safe).getUint16(entry.local + 8, true), 0);
  const stored = zipSync({ "word/document.xml": xml }, { level: 0 });
  assert.deepEqual(unzipSync(boundedDocxArchive(stored))["word/document.xml"], xml);
});

test("streaming ZIP entries with data descriptors are supported", () => {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, data) => { assert.ifError(error); chunks.push(data); });
  const document = new ZipDeflate("word/document.xml");
  zip.add(document);
  document.push(xml, true);
  zip.end();
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  assert.deepEqual(unzipSync(boundedDocxArchive(bytes))["word/document.xml"], xml);
});

test("declared huge entries and actual expansion behind forged tiny sizes are rejected", () => {
  const make = () => zipSync({ "word/document.xml": strToU8("x".repeat(16_000)) }, { level: 9 });
  assert.throws(() => boundedDocxArchive(forgeExpandedSizes(make(), 0xffffffff)), /damaged or too complex/);
  // Both local and central declarations lie; only actual streamed bytes expose
  // the expansion. It must stop before retaining more than the configured cap.
  assert.throws(() => boundedDocxArchive(forgeExpandedSizes(make(), 1), { entryBytes: 1024, totalBytes: 2048 }), /damaged or too complex/);
  assert.throws(() => boundedDocxArchive(forgeExpandedSizes(make(), 1)), /damaged or too complex/);
});

test("entry, total expansion, input and count caps include their exact boundary", () => {
  const bytes = zipSync({ "word/a.xml": strToU8("a".repeat(512)), "word/b.xml": strToU8("b".repeat(512)) });
  assert.doesNotThrow(() => boundedDocxArchive(bytes, { inputBytes: bytes.length, entryBytes: 512, totalBytes: 1024, entries: 2 }));
  for (const limits of [{ inputBytes: bytes.length - 1 }, { entryBytes: 511 }, { totalBytes: 1023 }, { entries: 1 }])
    assert.throws(() => boundedDocxArchive(bytes, limits), /damaged or too complex/);
  const forged = bytes.slice(), second = entries(forged)[1];
  view(forged).setUint32(second.local + 22, 1, true);
  view(forged).setUint32(second.central + 24, 1, true);
  assert.throws(() => boundedDocxArchive(forged, { entryBytes: 1024, totalBytes: 700 }), /damaged or too complex/);
});

test("duplicate names, traversal paths and mismatched local names cannot reach Mammoth", () => {
  const bytes = zipSync({ "word/a.xml": xml, "word/b.xml": xml });
  const duplicate = entries(bytes)[1];
  bytes[duplicate.local + 30 + 5] = "a".charCodeAt(0);
  bytes[duplicate.central + 46 + 5] = "a".charCodeAt(0);
  assert.throws(() => boundedDocxArchive(bytes), /damaged or too complex/);
  for (const name of ["../word/document.xml", "/word/document.xml", "word/../document.xml", "word\\document.xml", "C:/document.xml", "word//document.xml", "word/./document.xml"])
    assert.throws(() => boundedDocxArchive(zipSync({ [name]: xml })), /damaged or too complex/);
  const mismatch = zipSync({ "word/a.xml": xml });
  mismatch[30 + 5] = "b".charCodeAt(0);
  assert.throws(() => boundedDocxArchive(mismatch), /damaged or too complex/);
});

test("truncated archives, incomplete compressed entries and corrupt checksums fail closed", () => {
  const original = zipSync({ "word/document.xml": xml });
  for (const length of [0, 21, 40, original.length - 1, original.length - 10])
    assert.throws(() => boundedDocxArchive(original.subarray(0, length)));
  const entry = entries(original)[0], metadata = view(original);
  const compressed = metadata.getUint32(18, true), dataStart = 30 + metadata.getUint16(26, true) + metadata.getUint16(28, true);
  const broken = new Uint8Array(original.length - 2);
  broken.set(original.subarray(0, dataStart + compressed - 2));
  broken.set(original.subarray(dataStart + compressed), dataStart + compressed - 2);
  const patched = view(broken);
  patched.setUint32(18, compressed - 2, true);
  patched.setUint32(entry.central - 2 + 20, compressed - 2, true);
  patched.setUint32(broken.length - 22 + 16, entry.central - 2, true);
  assert.throws(() => boundedDocxArchive(broken));
  const corrupt = zipSync({ "word/document.xml": xml }, { level: 0 });
  corrupt[30 + view(corrupt).getUint16(26, true)] ^= 1;
  assert.throws(() => boundedDocxArchive(corrupt), /damaged or too complex/);
});

test("Office XML rejects DTD and entity declarations before XML parsing", () => {
  for (const text of ['<!DOCTYPE document [<!ENTITY boom "text">]><document>&boom;</document>', '<!ENTITY remote SYSTEM "https://example.test/private"><document/>']) {
    assert.throws(() => boundedDocxArchive(zipSync({ "word/document.xml": strToU8(text) })), /damaged or too complex/);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index++) view(utf16).setUint16(2 + index * 2, text.charCodeAt(index), true);
    assert.throws(() => boundedDocxArchive(zipSync({ "word/document.xml": utf16 })), /damaged or too complex/);
  }
  assert.doesNotThrow(() => boundedDocxArchive(zipSync({ "word/document.xml": strToU8("<document>&lt;!DOCTYPE text&gt;</document>") })));
});
