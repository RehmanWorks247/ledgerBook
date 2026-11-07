import { extname } from 'node:path';

// Infer metadata from the filename rather than trusting a client-supplied MIME type.
const types:Record<string,string> = {
  '.pdf':'application/pdf',
  '.doc':'application/msword',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt':'application/vnd.oasis.opendocument.text',
  '.rtf':'application/rtf',
  '.txt':'text/plain', '.csv':'text/csv', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif',
  '.bmp':'image/bmp', '.tif':'image/tiff', '.tiff':'image/tiff', '.heic':'image/heic',
  '.zip':'application/zip', '.7z':'application/x-7z-compressed', '.gz':'application/gzip',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.mp4':'video/mp4', '.mov':'video/quicktime',
};

export function documentExtension(filename:string) {
  // The original upload API accepted .pdf itself as a PDF filename.
  return filename.toLowerCase() === '.pdf' ? filename : extname(filename);
}

export function documentMimeType(filename:string) {
  return types[documentExtension(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function canPreviewDocument(mimeType:string) {
  return /^(application\/pdf|image\/(png|jpeg|gif|webp|avif|bmp))$/.test(mimeType);
}
