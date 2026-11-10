/* global localStorage, window, document */
// A same-origin, blocking script applies the saved theme before the first paint.
// Keeping it external also respects the application's script-src 'self' policy.
(function () {
  var preference = null;
  var accent = null;
  try {
    preference = localStorage.getItem("ledgerbook-theme");
  } catch { /* Use the system theme when storage is unavailable. */ }
  try {
    accent = localStorage.getItem("ledgerbook-accent");
  } catch { /* Use the default accent when storage is unavailable. */ }
  var theme = preference === "light" || preference === "dark"
    ? preference
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.accent =
    ["gold", "green", "blue", "violet", "amber", "rose", "neutral"].indexOf(accent) !== -1 ? accent : "gold";
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute(
    "content", theme === "dark" ? "#0a0a0a" : "#fafafa"
  );
})();
