import { useEffect, useState } from "react";
import { errorMessage } from "../api";
import { loadPrivateAsset } from "../private-assets";

type Asset = { path?: string; source?: Blob; attempt: number; blob?: Blob; url: string; error: string };

// Scope bytes and object URLs to the open modal. Abort reads and release memory
// on close, retry or file changes; never retain private files in a global cache.
export function usePreviewAsset(path: string | undefined, source: Blob | undefined, attempt: number, enabled = true) {
  const [asset, setAsset] = useState<Asset>();
  useEffect(() => {
    if (!enabled || (!path && !source)) return;
    const controller = new AbortController();
    let active = true;
    let url = "";
    const timeout = window.setTimeout(() => controller.abort(new Error("The file took too long to load. Please try again.")), 45_000);
    void (source ? Promise.resolve(source) : loadPrivateAsset(path!, controller.signal)).then(blob => {
      if (!active || controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setAsset({ path, source, attempt, blob, url, error: "" });
    }).catch(cause => {
      if (active && (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== "AbortError")) {
        setAsset({ path, source, attempt, url: "", error: errorMessage(controller.signal.aborted ? controller.signal.reason : cause) });
      }
    }).finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, source, attempt, enabled]);
  return enabled && asset?.path === path && asset?.source === source && asset?.attempt === attempt
    ? asset : { url: "", error: "", blob: undefined };
}
