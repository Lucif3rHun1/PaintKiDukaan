import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { setHash } from "@/lib/navigate";
import { UnsavedChangesModal } from "@/components/ui/UnsavedChangesModal";
import { isAnyFormDirty } from "@/pos/hooks";
import { readTab, readSalesSubRoute, readFormulasSubRoute, readInwardSubRoute } from "../router";
import type { AppShellTab } from "../AppShell";
import { requestGracefulQuit } from "./useQuitHandler";

export { requestGracefulQuit };

export function useNavGuard() {
  const [showNavGuard, setShowNavGuard] = useState(false);
  const [pendingNav, setPendingNav] = useState<{ tab: AppShellTab; hash?: string } | null>(null);
  const [pendingQuit, setPendingQuit] = useState(false);
  const prevHash = useRef(typeof window !== "undefined" ? window.location.hash : "");

  // Quit listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen("app://graceful-quit-requested", () => {
        requestGracefulQuit(() => {
          setPendingQuit(true);
          setShowNavGuard(true);
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  function navigate(t: AppShellTab, hash?: string) {
    if (isAnyFormDirty()) {
      setPendingNav({ tab: t, hash });
      setShowNavGuard(true);
      return;
    }
    setHash(hash ?? (t === "dashboard" ? "#/" : `#/${t}`));
  }

  function executeNav(t: AppShellTab, hash?: string) {
    setHash(hash ?? (t === "dashboard" ? "#/" : `#/${t}`));
  }

  /** Returns a setter that updates tab + sub-route state from the current hash */
  function makeHashHandler(
    setTab: (t: AppShellTab) => void,
    setSalesRoute: (r: ReturnType<typeof readSalesSubRoute>) => void,
    setInwardRoute: (r: ReturnType<typeof readInwardSubRoute>) => void,
    setFormulasRoute: (r: ReturnType<typeof readFormulasSubRoute>) => void,
  ) {
    return () => {
      if (typeof window === "undefined") return;
      if (window.location.hash === "#/items/barcodes") {
        window.location.replace("#/barcodes");
        return;
      }
      let suppressing = false;
      const onHash = () => {
        if (suppressing) { suppressing = false; return; }
        if (isAnyFormDirty()) {
          const targetHash = window.location.hash;
          const targetTab = readTab();
          suppressing = true;
          setHash(prevHash.current);
          setPendingNav({ tab: targetTab, hash: targetHash });
          setShowNavGuard(true);
          return;
        }
        prevHash.current = window.location.hash;
        setTab(readTab());
        setSalesRoute(readSalesSubRoute());
        setInwardRoute(readInwardSubRoute());
        setFormulasRoute(readFormulasSubRoute());
      };
      window.addEventListener("hashchange", onHash);
      return () => window.removeEventListener("hashchange", onHash);
    };
  }

  const navGuardJSX = (
    <UnsavedChangesModal
      open={showNavGuard}
      onSaveDraft={() => {
        const nav = pendingNav;
        const shouldQuit = pendingQuit;
        setShowNavGuard(false);
        setPendingNav(null);
        setPendingQuit(false);
        if (shouldQuit) void getCurrentWindow().close();
        if (nav) executeNav(nav.tab, nav.hash);
      }}
      onDiscard={() => {
        const nav = pendingNav;
        const shouldQuit = pendingQuit;
        setShowNavGuard(false);
        setPendingNav(null);
        setPendingQuit(false);
        if (shouldQuit) void getCurrentWindow().close();
        if (nav) executeNav(nav.tab, nav.hash);
      }}
      onCancel={() => {
        setShowNavGuard(false);
        setPendingNav(null);
        setPendingQuit(false);
      }}
    />
  );

  return { navigate, executeNav, makeHashHandler, navGuardJSX };
}
