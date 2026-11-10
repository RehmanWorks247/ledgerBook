import { Injectable, ServiceUnavailableException, UnprocessableEntityException, UnsupportedMediaTypeException, type OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'node:worker_threads';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_PREVIEWS = 2;
const OLE_SIGNATURE = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);

export type DocumentPreview = {mimeType:'text/plain; charset=utf-8'|'image/png';content:Buffer;mode:'text-only'|'first-page'};
type SourceDocument = {mimeType:string;content:Buffer};

function hasBoundedWordHeader(bytes:Buffer) {
  if (bytes.length < 512 || !bytes.subarray(0,8).equals(OLE_SIGNATURE)) return false;
  const major = bytes.readUInt16LE(26), sectorShift = bytes.readUInt16LE(30);
  if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12)) ||
    bytes.readUInt16LE(28) !== 0xfffe || bytes.readUInt16LE(32) !== 6 || bytes.readUInt32LE(56) !== 4096) return false;
  const sectorSize = 2 ** sectorShift, sectors = Math.floor(bytes.length / sectorSize) - 1;
  const allocationSectors = bytes.readUInt32LE(44), miniAllocationSectors = bytes.readUInt32LE(64), masterSectors = bytes.readUInt32LE(72);
  // word-extractor sizes native Buffers from these untrusted fields. Worker
  // heap limits alone do not constrain Buffer allocations, so reject impossible
  // table sizes before starting it. Table entries cannot outgrow the file.
  return sectors > 0 && allocationSectors > 0 && allocationSectors <= Math.ceil(sectors / (sectorSize / 4)) &&
    miniAllocationSectors <= Math.ceil((bytes.length / 64) / (sectorSize / 4)) && masterSectors <= sectors;
}

// Only this fixed program executes in the worker. The uploaded bytes are data,
// never code or a filesystem path. Both parsers receive a Buffer, so linked
// documents and remote resources are not resolved.
const PREVIEW_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const bytes = Buffer.from(workerData.bytes);
    let content;
    if (workerData.kind === 'doc') {
      const WordExtractor = require(workerData.modulePath);
      const document = await new WordExtractor().extract(bytes);
      const sections = [document.getBody()];
      for (const [label, method] of [['Footnotes', 'getFootnotes'], ['Endnotes', 'getEndnotes'], ['Headers and footers', 'getHeaders']]) {
        const text = document[method]();
        if (text.trim()) sections.push(label + '\n' + text);
      }
      const text = sections.join('\n\n').replace(/\u0000/g, '').trim();
      if (!text || Buffer.byteLength(text, 'utf8') > workerData.maxOutputBytes) throw new Error('Invalid preview');
      content = Buffer.from(text, 'utf8');
    } else {
      const sharp = require(workerData.modulePath);
      content = await sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning', page: 0, pages: 1, animated: false })
        .autoOrient().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .png().timeout({ seconds: 6 }).toBuffer();
      if (!content.length || content.length > workerData.maxOutputBytes) throw new Error('Invalid preview');
    }
    parentPort.postMessage({ ok: true, content });
  } catch {
    parentPort.postMessage({ ok: false });
  }
})();
`;

/** Short-lived workers keep untrusted parsing off the API event loop. */
@Injectable()
export class DocumentPreviewService implements OnApplicationShutdown {
  private readonly workers = new Set<Worker>();
  private stopping = false;
  protected timeoutMs = 8_000;

  async render(document:SourceDocument, signal?:AbortSignal):Promise<DocumentPreview> {
    const kind = document.mimeType === 'application/msword' ? 'doc' : document.mimeType === 'image/tiff' ? 'tiff' : undefined;
    if (!kind) throw new UnsupportedMediaTypeException('This file type does not need document conversion. Download the original file if a preview is unavailable.');
    const bytes = document.content;
    const validHeader = kind === 'doc' ? hasBoundedWordHeader(bytes) :
      bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && [42,43].includes(bytes[2]) && bytes[3] === 0) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && [42,43].includes(bytes[3])));
    if (!bytes.length || bytes.length > MAX_INPUT_BYTES || !validHeader) throw this.invalid(kind);
    if (this.stopping || signal?.aborted) throw new ServiceUnavailableException('The preview was interrupted. Reopen the file to try again.');
    if (this.workers.size >= MAX_ACTIVE_PREVIEWS) throw new ServiceUnavailableException('The preview service is busy. Please retry in a few seconds.');

    const maxOutputBytes = kind === 'doc' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
    let worker:Worker;
    try {
      worker = new Worker(PREVIEW_WORKER, {
        eval:true, execArgv:[], stdout:true, stderr:true,
        workerData:{kind,bytes,modulePath:require.resolve(kind === 'doc' ? 'word-extractor' : 'sharp'),maxOutputBytes},
        resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4},
      });
    } catch {
      throw new ServiceUnavailableException('Document previews are temporarily unavailable. Download the original file or retry later.');
    }
    this.workers.add(worker);
    worker.stdout?.resume();
    worker.stderr?.resume();
    try {
      const content = await new Promise<Buffer>((resolve,reject) => {
        let settled = false;
        const finish = (error?:Error, content?:Buffer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort',aborted);
          if (error) reject(error); else resolve(content!);
        };
        const aborted = () => finish(new ServiceUnavailableException('The preview was interrupted. Reopen the file to try again.'));
        const timer = setTimeout(() => finish(new UnprocessableEntityException('This file took too long to preview. Download the original file to open it.')),this.timeoutMs);
        timer.unref();
        signal?.addEventListener('abort',aborted,{once:true});
        if (signal?.aborted) aborted();
        worker.once('message',(message:unknown) => {
          const result = message as {ok?:boolean;content?:unknown};
          if (!result?.ok || !(result.content instanceof Uint8Array) || !result.content.length || result.content.byteLength > maxOutputBytes) {
            finish(this.invalid(kind));
          } else finish(undefined,Buffer.from(result.content));
        });
        worker.once('error',() => finish(this.invalid(kind)));
        worker.once('exit',() => finish(this.invalid(kind)));
      });
      return {content,mimeType:kind === 'doc' ? 'text/plain; charset=utf-8' : 'image/png',mode:kind === 'doc' ? 'text-only' : 'first-page'};
    } finally {
      // Keep the concurrency slot until termination completes, including aborts
      // and parser timeouts. A slow parser cannot create an unbounded queue.
      await worker.terminate();
      this.workers.delete(worker);
    }
  }

  private invalid(kind:'doc'|'tiff') {
    return new UnprocessableEntityException(kind === 'doc'
      ? 'This Word document could not be previewed. It may be damaged, password protected, or too large to display. Download the original file to open it.'
      : 'This TIFF image could not be previewed. It may be damaged or exceed the 16 megapixel preview limit. Download the original file to open it.');
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await Promise.allSettled([...this.workers].map(worker => worker.terminate()));
  }
}
