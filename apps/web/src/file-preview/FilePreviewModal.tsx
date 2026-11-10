import { Component, lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Download, FileQuestion, FileText, LoaderCircle, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { fileSize, MAX_PREVIEW_BYTES, MAX_TEXT_BYTES, previewKind, serverPreviewPath, type PreviewFile } from "./model";
import { usePreviewAsset } from "./use-preview-asset";

const PdfPreview = lazy(() => import("./PdfPreview"));
const DocxPreview = lazy(() => import("./DocxPreview"));

export function PreviewLoading({ message = "Loading preview…" }: { message?: string }) {
  return <div className="file-preview-state" role="status"><LoaderCircle className="file-preview-spinner" size={28} /><p>{message}</p></div>;
}

class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="file-preview-state" role="alert"><AlertCircle size={30} /><h3>Preview could not be loaded</h3><p>Try opening this preview again, or download a copy.</p></div> : this.props.children;
  }
}

function ImagePreview({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(entries => setViewport({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  const fit = natural.width && natural.height ? Math.min(1, Math.max(1, viewport.width - 48) / natural.width, Math.max(1, viewport.height - 48) / natural.height) : 1;
  const width = natural.width * fit * zoom;
  const height = natural.height * fit * zoom;
  if (failed) return <div className="file-preview-state" role="alert"><FileQuestion size={30} /><h3>This image cannot be displayed</h3><p>It may be damaged or use a format this browser does not support. Download a copy to open it in an image app.</p></div>;
  return <div className="file-preview-image-view">
    <div className="file-preview-tools" aria-label="Image controls">
      <button type="button" className="icon-button" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><ZoomOut size={17} /></button>
      <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button type="button" className="icon-button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}><ZoomIn size={17} /></button>
      <button type="button" className="button secondary" onClick={() => setZoom(1)}>Fit image</button>
    </div>
    <div ref={scroll} className="file-preview-image-scroll">
      {!loaded && <PreviewLoading />}
      <div className="file-preview-image-stage" style={{ width: Math.max(viewport.width, width + 48), height: Math.max(viewport.height, height + 48) }}>
        <img src={url} alt={name} decoding="async" onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); }} onError={() => setFailed(true)} style={{ visibility: loaded ? "visible" : "hidden", width: width || undefined, height: height || undefined }} />
      </div>
    </div>
  </div>;
}

function TextPreview({ blob, legacy = false }: { blob: Blob; legacy?: boolean }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void blob.slice(0, MAX_TEXT_BYTES).text().then(value => { if (active) setText(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [blob]);
  if (failed) return <div className="file-preview-state" role="alert"><p>This text could not be read. Download a copy to open it.</p></div>;
  if (text === undefined) return <PreviewLoading />;
  return <div className="file-preview-document-scroll">
    {legacy && <p className="file-preview-note">Text preview · Download the original Word document for its full formatting and images.</p>}
    {blob.size > MAX_TEXT_BYTES && <p className="file-preview-note">Showing the first 1 MB. Download a copy to view the whole file.</p>}
    <pre className="file-preview-text" dir="auto">{text || "This document is empty."}</pre>
  </div>;
}

function MediaPreview({ url, kind }: { url: string; kind: "audio" | "video" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="file-preview-state" role="alert"><p>This browser cannot play the file. Download a copy to open it.</p></div>;
  return <div className="file-preview-media">{kind === "video" ? <video src={url} controls preload="metadata" onError={() => setFailed(true)} /> : <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />}</div>;
}

export function FilePreviewModal({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [fetchOriginal, setFetchOriginal] = useState(false);
  const kind = previewKind(file);
  const converted = kind === "doc" || kind === "tiff";
  const convertedPath = converted ? serverPreviewPath(file.url) : undefined;
  const declaredTooLarge = Math.max(file.size ?? 0, file.blob?.size ?? 0) > MAX_PREVIEW_BYTES;
  const original = usePreviewAsset(file.url, file.blob, attempt, !converted && kind !== "unsupported" && !declaredTooLarge || fetchOriginal);
  const derived = usePreviewAsset(convertedPath, undefined, attempt, !!convertedPath);
  const asset = converted ? derived : original;
  const download = useRef<HTMLAnchorElement>(null);
  const error = asset.error || (downloadRequested ? original.error : "");
  const tooLarge = declaredTooLarge || !converted && (asset.blob?.size ?? 0) > MAX_PREVIEW_BYTES;
  const unsupported = kind === "unsupported" || tooLarge || converted && !convertedPath;

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    closeButton.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (downloadRequested && original.url) {
      download.current?.click();
      setDownloadRequested(false);
    }
  }, [downloadRequested, original.url]);

  return <dialog ref={dialog} className="file-preview-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      // Explicit wrapping also keeps focus inside a preview nested in a payment
      // review dialog, without sending the last Tab to the browser toolbar.
      event.stopPropagation();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0'], video[controls], audio[controls]"))
        .filter(element => element.getClientRects().length > 0);
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      // Safari's system keyboard preferences can skip otherwise focusable
      // controls. Advance explicitly so every modal action remains reachable.
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
      items[next].focus();
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="file-preview-heading">
      <span className="file-preview-file-icon"><FileText size={22} aria-hidden="true" /></span>
      <div className="file-preview-title"><h2 id={titleId}>{file.name}</h2><p>File preview{fileSize(file.size ?? file.blob?.size) && ` · ${fileSize(file.size ?? file.blob?.size)}`}</p></div>
      {original.url ? <a ref={download} className="button secondary file-preview-download" href={original.url} download={file.name}><Download size={16} /><span>Download copy</span></a>
        : <button type="button" className="button secondary file-preview-download" disabled={downloadRequested || !file.url && !file.blob} onClick={() => { setFetchOriginal(true); setDownloadRequested(true); }}><Download size={16} /><span>{downloadRequested ? "Preparing download…" : "Download copy"}</span></button>}
      <button ref={closeButton} type="button" className="icon-button file-preview-close" aria-label="Close preview" onClick={onClose}><X size={21} /></button>
    </header>
    <div className="file-preview-body">
      {error ? <div className="file-preview-state" role="alert"><AlertCircle size={30} /><h3>Preview could not be loaded</h3><p>{error}</p><button className="button secondary" type="button" aria-label="Retry preview" onClick={() => { setDownloadRequested(false); setAttempt(value => value + 1); }}><RotateCcw size={16} />Try again</button></div>
        : unsupported ? <div className="file-preview-state"><FileQuestion size={36} /><h3>{tooLarge ? "This file is too large to preview" : "No preview available"}</h3><p>{converted && !convertedPath ? "Save this file to a booking to generate its preview." : "Download a copy to open this file in its original application."}</p></div>
        : !file.url && !file.blob ? <div className="file-preview-state"><FileQuestion size={36} /><h3>File contents are not available</h3></div>
        : !asset.blob ? <PreviewLoading message={converted ? "Preparing preview…" : undefined} />
        : <RendererBoundary key={asset.url}><Suspense fallback={<PreviewLoading />}>
          {kind === "pdf" ? <PdfPreview blob={asset.blob} />
            : kind === "docx" ? <DocxPreview blob={asset.blob} />
            : kind === "image" || kind === "tiff" ? <ImagePreview key={asset.url} url={asset.url} name={file.name} />
            : kind === "text" || kind === "doc" ? <TextPreview key={asset.url} blob={asset.blob} legacy={kind === "doc"} />
            : kind === "video" || kind === "audio" ? <MediaPreview key={asset.url} url={asset.url} kind={kind} /> : null}
        </Suspense></RendererBoundary>}
    </div>
    <footer className="file-preview-footer"><span>{kind === "tiff" ? "First page preview" : kind === "docx" ? "Word preview · Layout may differ from the original" : "Your original file stays unchanged"}</span><span>Esc to close</span></footer>
  </dialog>;
}
