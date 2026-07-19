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

const PrimitiveShowcase = React.lazy(() =>
  import("./dev/PrimitiveShowcase").then((module) => ({ default: module.PrimitiveShowcase })),
);

const isPrimitiveShowcase = import.meta.env.DEV && window.location.hash === "#/__showcase";

// Must run BEFORE React mounts so console overrides are in place before any
// component renders.
applyInitialTheme();
if (!isPrimitiveShowcase) initSessionLog();

if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {isPrimitiveShowcase ? (
            <React.Suspense fallback={null}>
              <PrimitiveShowcase />
            </React.Suspense>
          ) : (
            <App />
          )}
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
