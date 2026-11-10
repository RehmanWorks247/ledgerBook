import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

export default function DocxPreview({ blob }: { blob: Blob }) {
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const worker = new Worker(new URL("./docx.worker.ts", import.meta.url), { type: "module" });
    const timer = window.setTimeout(() => {
      worker.terminate();
      if (active) setError("This Word document took too long to render. Download a copy to open it.");
    }, 15_000);
    worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => {
      window.clearTimeout(timer);
      worker.terminate();
      if (!active) return;
      if (event.data.error) { setError(event.data.error); return; }
      // Keep semantic document formatting, but discard styles, links, scripts,
      // active elements and external images. Only embedded raster images survive.
      const clean = DOMPurify.sanitize(event.data.html || "", {
        ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "sup", "sub", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "img", "span"],
        ALLOWED_ATTR: ["src", "alt", "colspan", "rowspan"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
        ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i,
      });
      setHtml(clean);
    };
    worker.onerror = event => {
      event.preventDefault(); window.clearTimeout(timer); worker.terminate();
      if (active) setError("The Word preview could not be loaded. Download a copy to open it.");
    };
    void blob.arrayBuffer().then(data => { if (active) worker.postMessage(data, [data]); }).catch(() => {
      if (active) setError("The Word document could not be read. Download a copy to open it.");
    });
    return () => { active = false; window.clearTimeout(timer); worker.terminate(); };
  }, [blob]);
  if (error) return <div className="file-preview-state" role="alert"><h3>Word preview unavailable</h3><p>{error}</p></div>;
  if (html === undefined) return <div className="file-preview-state" role="status"><span className="spinner" /><p>Rendering Word document…</p></div>;
  return <div className="file-preview-document-scroll"><article className="file-preview-word" aria-label="Word document content" dir="auto" dangerouslySetInnerHTML={{ __html: html || "<p>This document contains no previewable text or images.</p>" }} /></div>;
}
