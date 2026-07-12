/** Centralized hash navigation helper. All components should use this
 *  instead of writing `window.location.hash` directly so the dirty-guard
 *  hashchange listener in App.tsx can intercept cross-route navigation. */
export function setHash(hash: string): void {
  window.location.hash = hash;
}
