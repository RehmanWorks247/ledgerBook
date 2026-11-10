import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilePreviewModal } from "../src/file-preview/FilePreviewModal";
import { MAX_PREVIEW_BYTES, previewKind, serverPreviewPath } from "../src/file-preview/model";

test("preview routing recognizes common files without promoting active or unknown content", () => {
  for (const name of ["scan.PNG", "photo.jpeg", "photo.jpg", "animation.gif", "picture.webp", "image.avif", "icon.svg", "icon.ico"])
    assert.equal(previewKind({ name }), "image");
  assert.equal(previewKind({ name: "Document.PDF", mimeType: "application/octet-stream" }), "pdf");
  assert.equal(previewKind({ name: "contract.docx" }), "docx");
  assert.equal(previewKind({ name: "contract.doc" }), "doc");
  assert.equal(previewKind({ name: "scan.TIFF" }), "tiff");
  assert.equal(previewKind({ name: "instructions", mimeType: "text/plain; charset=utf-8" }), "text");
  assert.equal(previewKind({ name: "notes.json" }), "text");
  assert.equal(previewKind({ name: "recording.mp3" }), "audio");
  assert.equal(previewKind({ name: "clip.mp4" }), "video");
  for (const name of ["page.html", "application.js", "macro.docm", "archive.zip", "executable.exe"])
    assert.equal(previewKind({ name }), "unsupported");
  for (const mimeType of ["text/html", "application/xhtml+xml", "application/javascript"])
    assert.equal(previewKind({ name: "misleading.pdf", mimeType }), "unsupported");
});

test("derived previews only target the current authenticated booking-document route", () => {
  const path = "/api/organizations/org/customers/customer/bookings/booking/documents/doc";
  assert.equal(serverPreviewPath(path), `${path}/preview`);
  for (const path of [undefined, "https://outside.test/file", "//outside.test/file", "/api/organizations/org/file",
    "/api/organizations/org/customers/customer/bookings/booking/documents/doc?download=1",
    "/api/organizations/org/customers/customer/bookings/booking/documents/doc/versions/1",
    "/api/organizations/org/customers/customer/bookings/booking/documents/doc#fragment",
    "/api/organizations/org/customers/customer/bookings/booking/documents/\\outside"])
    assert.equal(serverPreviewPath(path), undefined);
});

test("unavailable and oversized previews keep modal controls and never embed active documents", () => {
  const render = (name: string, blob?: Blob, size?: number) => renderToStaticMarkup(createElement(FilePreviewModal, { file: { name, blob, size }, onClose() {} }));
  const unsupported = render("untrusted.html");
  assert.match(unsupported, /No preview available/);
  assert.match(unsupported, /Close preview/);
  assert.doesNotMatch(unsupported, /<iframe|<object|<embed/);
  const large = render("oversized.png", new Blob([new Uint8Array(MAX_PREVIEW_BYTES + 1)]), 1);
  assert.match(large, /too large to preview/);
  assert.match(large, /Download copy/);
  assert.doesNotMatch(large, /<img/);
});
