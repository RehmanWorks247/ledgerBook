import { useEffect, useState } from "react";
import { ApiError, authenticatedFetch, errorMessage } from "./api";

// Private document URLs are API paths. Fetch with the current Clerk session;
// normal image and anchor requests cannot attach an Authorization header.
export async function loadPrivateAsset(path: string, signal?: AbortSignal) {
  if (!path.startsWith("/api/organizations/") || path.includes("\\"))
    throw new Error("The attachment address is invalid.");
  const response = await authenticatedFetch(path.slice(4), { signal });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new ApiError(detail.message || "This attachment could not be loaded. Please try again.", response.status);
  }
  return response.blob();
}

export function usePrivateAsset(path?: string, file?: File) {
  const [asset, setAsset] = useState<{ path?: string; file?: File; url: string; error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    if (file || path) {
      const load = file ? Promise.resolve(file) : loadPrivateAsset(path!, controller.signal);
      void load.then(blob => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setAsset({ path, file, url, error: "" });
      }).catch(cause => {
        if (!controller.signal.aborted) setAsset({ path, file, url: "", error: errorMessage(cause) });
      });
    }
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, file]);
  return asset && asset.path === path && asset.file === file ? asset : { url: "", error: "" };
}
