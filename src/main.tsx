import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { initSessionLog } from "./lib/security/sessionLog";
import { AppErrorBoundary } from "./components/ui/AppErrorBoundary";
import { applyInitialTheme } from "./lib/theme";
import { queryClient } from "./lib/query/queryClient";
import "./index.css";

// Must run BEFORE React mounts so console overrides are in place before any
// component renders. Calling initSessionLog() inside App()'s render body is
// unsafe — see the docstring on initSessionLog for details.
applyInitialTheme();
initSessionLog();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
