import mammoth from "mammoth";
import { boundedDocxArchive } from "./docx-archive";

// A dedicated, disposable worker prevents malformed Office input from blocking
// the UI. The caller terminates it on cancellation or after its time budget.
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const archive = boundedDocxArchive(new Uint8Array(event.data));
    const result = await mammoth.convertToHtml({ arrayBuffer: archive.buffer as ArrayBuffer }, {
      externalFileAccess: false, includeEmbeddedStyleMap: false, idPrefix: "word-preview-",
      convertImage: mammoth.images.imgElement(async image => {
        if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(image.contentType)) return { src: "" };
        const data = await image.readAsBase64String();
        if (data.length > 4 * 1024 * 1024) return { src: "" };
        return { src: `data:${image.contentType};base64,${data}` };
      }),
    });
    if (result.value.length > 6 * 1024 * 1024) throw new Error("This Word document is too complex to preview. Download a copy to open it.");
    let elements = 0;
    for (let index = 0; index < result.value.length; index++) {
      if (result.value[index] === "<" && ++elements > 20_000) throw new Error("This Word document is too complex to preview.");
    }
    self.postMessage({ html: result.value });
  } catch {
    self.postMessage({ error: "This Word document could not be displayed. It may be damaged, password protected or too complex to preview." });
  }
};
