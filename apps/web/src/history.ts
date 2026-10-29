const navigationEvent = "ledgerbook:navigation";

export function navigateTo(to: string, options: { replace?: boolean } = {}) {
  const destination = new URL(to, window.location.origin);
  if (destination.origin !== window.location.origin)
    throw new Error("External navigation is not supported.");
  window.history[options.replace ? "replaceState" : "pushState"](
    null,
    "",
    destination.pathname + destination.search + destination.hash,
  );
  window.dispatchEvent(new Event(navigationEvent));
}

export function subscribeToNavigation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(navigationEvent, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(navigationEvent, onChange);
  };
}
