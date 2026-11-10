export type PreviewFile = { name: string; mimeType?: string; size?: number; url?: string; blob?: Blob };
export type PreviewKind = "image" | "pdf" | "docx" | "doc" | "tiff" | "text" | "audio" | "video" | "unsupported";
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;

const extensions: Record<string, PreviewKind> = {
  pdf: "pdf", docx: "docx", doc: "doc", tif: "tiff", tiff: "tiff",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image",
  bmp: "image", ico: "image", svg: "image", heic: "image", heif: "image",
  txt: "text", md: "text", markdown: "text", csv: "text", json: "text", log: "text",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  mp4: "video", webm: "video", mov: "video",
};

export function previewKind(file: Pick<PreviewFile, "name" | "mimeType">): PreviewKind {
  const type = file.mimeType?.split(";")[0].trim().toLowerCase() || "";
  // Active content is never treated as a document, even with a misleading name.
  if (/^(text\/html|application\/(xhtml\+xml|javascript)|text\/javascript)$/.test(type)) return "unsupported";
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (extensions[extension]) return extensions[extension];
  if (type === "application/pdf") return "pdf";
  if (type === "application/msword") return "doc";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (type === "image/tiff") return "tiff";
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd.microsoft.icon|svg\+xml|heic|heif)$/.test(type)) return "image";
  if (/^(text\/(plain|csv|markdown)|application\/json)$/.test(type)) return "text";
  if (/^audio\/(mpeg|wav|x-wav|ogg|mp4|flac)$/.test(type)) return "audio";
  if (/^video\/(mp4|webm|quicktime)$/.test(type)) return "video";
  return "unsupported";
}

export function serverPreviewPath(path?: string) {
  // Only the current booking document route exposes derived previews. Do not
  // forward arbitrary URLs, query strings or receipt addresses to a converter.
  return path && /^\/api\/organizations\/[^/?#\\]+\/customers\/[^/?#\\]+\/bookings\/[^/?#\\]+\/documents\/[^/?#\\]+$/.test(path)
    ? `${path}/preview` : undefined;
}

export function fileSize(bytes?: number) {
  if (bytes === undefined) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
