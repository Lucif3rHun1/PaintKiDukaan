import { useEffect, useState } from "react";
import type { AppShellTab } from "../AppShell";
import {
  readTab,
  readSalesSubRoute,
  readInwardSubRoute,
  readFormulasSubRoute,
} from "../router";
import { useNavGuard } from "./useNavGuard";

type SalesSubRoute = ReturnType<typeof readSalesSubRoute>;
type InwardSubRoute = ReturnType<typeof readInwardSubRoute>;
type FormulasSubRoute = ReturnType<typeof readFormulasSubRoute>;

/**
 * Owns the active tab + sub-route state and wires the hashchange listener.
 *
 * Internally delegates navigation guards (form-dirty suppression, quit
 * confirmation) to {@link useNavGuard} so App.tsx only needs one hook call
 * for the full routing + nav-guard surface.
 */
export function useTabRouting() {
  const [tab, setTab] = useState<AppShellTab>(readTab);
  const [salesRoute, setSalesRoute] = useState<SalesSubRoute>(readSalesSubRoute);
  const [inwardRoute, setInwardRoute] = useState<InwardSubRoute>(readInwardSubRoute);
  const [formulasRoute, setFormulasRoute] = useState<FormulasSubRoute>(readFormulasSubRoute);

  const { navigate, makeHashHandler, navGuardJSX } = useNavGuard();

  useEffect(
    makeHashHandler(setTab, setSalesRoute, setInwardRoute, setFormulasRoute),
    [makeHashHandler],
  );

  return {
    tab,
    setTab,
    salesRoute,
    setSalesRoute,
    inwardRoute,
    setInwardRoute,
    formulasRoute,
    setFormulasRoute,
    navigate,
    navGuardJSX,
  };
}
