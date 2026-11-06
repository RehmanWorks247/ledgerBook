import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "./router";
import { App } from "./App";
import { ThemeProvider } from "./theme";
import "./styles.css";
import "./pages/ListFilters.css";
import "./pages/Users.css";
import "./pages/UserRecord.css";
import "./user-files/explorer.css";
import "./theme-palettes.css";
import "./pages/Settings.css";
import "./currency.css";
import "./pages/Dashboard.css";
import "./CustomerPicker.css";
import "./payments/PaymentReview.css";
import "./semantic-colors.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
