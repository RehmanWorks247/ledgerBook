import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { getDocument, GlobalWorkerOptions, TextLayer, version, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ blob }: { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setError("This PDF took too long to open. Download a copy to view it.");
      void task?.destroy();
    }, 25_000);
    void blob.arrayBuffer().then(data => {
      if (!active) return;
      const assets = `/pdf-assets/${version}/`;
      task = getDocument({ data: new Uint8Array(data), cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`,
        useWasm: false, enableXfa: false, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32 * 1024 * 1024 });
      return task.promise.then(document => { if (active) setPdf(document); });
    }).catch(cause => {
      if (active) setError(cause?.name === "PasswordException"
        ? "This PDF is password protected. Download it to open with your password."
        : "This PDF could not be displayed. It may be damaged or use an unsupported format.");
    }).finally(() => window.clearTimeout(timer));
    return () => { active = false; window.clearTimeout(timer); void task?.destroy(); };
  }, [blob]);

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(160, Math.floor(entries[0].contentRect.width - 40))));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !sheet.current) return;
    let active = true;
    let render: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const textContainer = document.createElement("div");
    textContainer.className = "textLayer";
    sheet.current.replaceChildren(canvas, textContainer);
    setLoading(true);
    const timer = window.setTimeout(() => {
      if (!active) return;
      active = false;
      render?.cancel();
      textLayer?.cancel();
      setError("This page is too complex to preview. Download a copy to view the PDF.");
    }, 25_000);
    void pdf.getPage(page).then(async documentPage => {
      if (!active) return;
      const natural = documentPage.getViewport({ scale: 1 });
      const scale = Math.min(width / natural.width, 1.5) * zoom;
      const view = documentPage.getViewport({ scale });
      // Bound backing canvas memory independently of zoom or device density.
      const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (view.width * view.height)));
      canvas.width = Math.max(1, Math.floor(view.width * density));
      canvas.height = Math.max(1, Math.floor(view.height * density));
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      // Text uses the same viewport as the page, independently of the canvas's
      // backing resolution, so selection stays aligned at every zoom/density.
      const textScale = view.scale * view.userUnit;
      textContainer.style.setProperty("--total-scale-factor", String(textScale));
      textLayer = new TextLayer({ textContentSource: documentPage.streamTextContent(), container: textContainer, viewport: view });
      const sideways = view.rotation % 180 !== 0;
      textContainer.style.width = `${sideways ? view.height : view.width}px`;
      textContainer.style.height = `${sideways ? view.width : view.height}px`;
      render = documentPage.render({ canvas, viewport: view, transform: [density, 0, 0, density, 0, 0] });
      await Promise.all([render.promise, textLayer.render()]);
      if (!active) return;
      setLoading(false);
    }).catch(cause => {
      render?.cancel();
      textLayer?.cancel();
      if (active && cause?.name !== "RenderingCancelledException") setError("This page could not be displayed. Download a copy to view the PDF.");
    }).finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      window.clearTimeout(timer);
      render?.cancel();
      textLayer?.cancel();
      textContainer.remove();
      canvas.remove();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [pdf, page, zoom, width]);

  return <div className="file-preview-pdf">
    <div className="file-preview-tools" aria-label="PDF controls">
      <button className="icon-button" type="button" aria-label="Previous page" disabled={!pdf || page <= 1 || !!error} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></button>
      <output aria-live="polite">Page {page} of {pdf?.numPages ?? "…"}</output>
      <button className="icon-button" type="button" aria-label="Next page" disabled={!pdf || page >= pdf.numPages || !!error} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></button>
      <span className="file-preview-tool-divider" />
      <button className="icon-button" type="button" aria-label="Zoom out" disabled={zoom <= .5 || !!error} onClick={() => setZoom(value => Math.max(.5, value - .25))}><ZoomOut size={17} /></button>
      <output>{Math.round(zoom * 100)}%</output>
      <button className="icon-button" type="button" aria-label="Zoom in" disabled={zoom >= 3 || !!error} onClick={() => setZoom(value => Math.min(3, value + .25))}><ZoomIn size={17} /></button>
      <button className="button secondary" type="button" onClick={() => setZoom(1)}>Fit page</button>
    </div>
    {error ? <div className="file-preview-state" role="alert"><h3>PDF preview unavailable</h3><p>{error}</p></div> : <>
      <div ref={viewport} className="file-preview-pdf-scroll" aria-label={`PDF page ${page}`} aria-busy={loading}>
        {loading && <div className="file-preview-page-loading" role="status">Rendering page…</div>}
        <div ref={sheet} className="file-preview-pdf-sheet" />
      </div>
    </>}
  </div>;
}
