export function readInvitationLink(url: URL) {
  return {
    token:
      url.searchParams.get("token") ||
      (url.pathname === "/invite" ? url.hash.slice(1) : ""),
    ticket: url.searchParams.get("__clerk_ticket") || "",
  };
}

// Keep the link in memory while switching between invitation and sign-in screens.
// The email URL remains usable after a refresh; nothing is written to browser storage.
export const invitationLink =
  typeof window === "undefined"
    ? { token: "", ticket: "" }
    : readInvitationLink(new URL(window.location.href));

export function invitationUrl(path = "/invite") {
  const query = new URLSearchParams();
  if (invitationLink.token) query.set("token", invitationLink.token);
  if (invitationLink.ticket) query.set("__clerk_ticket", invitationLink.ticket);
  return `${path}${query.size ? `?${query}` : ""}`;
}

export function clearInvitation() {
  invitationLink.token = "";
  invitationLink.ticket = "";
  window.history.replaceState(null, "", window.location.pathname);
}

// A second invitation may arrive through same-tab or fragment-only navigation.
export function captureInvitationLink() {
  const url = new URL(window.location.href);
  if (!["/invite", "/login", "/forgot-password", "/reset-password"].includes(url.pathname)) return false;
  const next = readInvitationLink(url);
  if (!next.token && !next.ticket) return false;
  if (next.token === invitationLink.token && next.ticket === invitationLink.ticket) return false;
  Object.assign(invitationLink, next);
  return true;
}
