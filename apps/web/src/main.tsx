import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { BrowserRouter } from "./router";
import { navigateTo } from "./history";
import { api, errorMessage } from "./api";
import { Brand, ErrorNotice, Loading } from "./components";
import { App } from "./App";
import { ThemeProvider } from "./theme";
import "./styles.css";
import "./pages/ListFilters.css";
import "./pages/Users.css";
import "./pages/UserRecord.css";
import "./user-files/explorer.css";
import "./file-preview/preview.css";
import "./theme-palettes.css";
import "./pages/Settings.css";
import "./currency.css";
import "./pages/Dashboard.css";
import "./CustomerPicker.css";
import "./payments/PaymentReview.css";
import "./semantic-colors.css";

type AuthConfig = { provider: string; publishableKey: string | null };
function Bootstrap() {
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<AuthConfig>("/auth/config", { signal: controller.signal })
      .then((value) => {
        if (value.provider !== "clerk" || !value.publishableKey)
          throw new Error(
            "Clerk authentication has not been configured. Ask your administrator to configure the Clerk keys and restart the server.",
          );
        setConfig(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <main className="standalone">
        <Brand />
        <h1>Unable to load sign in</h1>
        <ErrorNotice message={error} />
        <button className="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  if (!config?.publishableKey) return <Loading full />;
  return (
    <ClerkProvider
      publishableKey={config.publishableKey}
      signInUrl="/login"
      signUpUrl="/invite"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/invite"
      afterSignOutUrl="/login"
      routerPush={(to) => navigateTo(to)}
      routerReplace={(to) => navigateTo(to, { replace: true })}
      appearance={{
        variables: {
          colorPrimary: "var(--primary)",
          colorPrimaryForeground: "var(--on-primary)",
          colorNeutral: "var(--text)",
          colorForeground: "var(--text)",
          colorMuted: "var(--surface-subtle)",
          colorMutedForeground: "var(--muted)",
          colorBackground: "var(--surface)",
          colorInput: "var(--surface)",
          colorInputForeground: "var(--text)",
          colorBorder: "var(--line-strong)",
          colorRing: "var(--accent)",
          colorDanger: "var(--danger)",
          colorSuccess: "var(--success)",
          colorWarning: "var(--warning)",
          colorModalBackdrop: "var(--overlay)",
          fontFamily: "inherit",
          fontFamilyButtons: "inherit",
          borderRadius: "var(--radius)",
        },
        elements: {
          formButtonPrimary: {
            backgroundColor: "var(--primary)",
            color: "var(--on-primary)",
            "&:hover": { backgroundColor: "var(--primary-hover)" },
          },
          profileSectionPrimaryButton: { color: "var(--accent)" },
          footerActionLink: { color: "var(--accent)" },
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Bootstrap />
    </ThemeProvider>
  </React.StrictMode>,
);
