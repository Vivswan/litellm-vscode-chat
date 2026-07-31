/**
 * Where the dashboard webview bundle lives, relative to the extension root.
 * Producer and consumer both derive the path from these segments -
 * scripts/dev/esbuild.mts writes the bundle there and the dashboard panel loads
 * it from there - so the two cannot drift. Pure constants: no vscode, no
 * Node (the esbuild script imports this file outside the extension host).
 */

/** The directory holding webview bundles, as path segments from the extension root. */
export const WEBVIEW_DIST_SEGMENTS = ["dist", "webview"] as const;

/** The dashboard bundle's filename inside WEBVIEW_DIST_SEGMENTS. */
export const DASHBOARD_BUNDLE_FILENAME = "dashboard.js";
