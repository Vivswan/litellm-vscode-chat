/**
 * Where the dashboard webview bundle lives, relative to the extension root.
 * The bundle script and the dashboard panel both derive the path from these
 * segments, so the two cannot drift. Pure constants: no vscode, no Node (the
 * bundle script imports this file outside the extension host).
 */

/** The directory holding webview bundles, as path segments from the extension root. */
export const WEBVIEW_DIST_SEGMENTS = ["dist", "webview"] as const;

/** The dashboard bundle's filename inside WEBVIEW_DIST_SEGMENTS. */
export const DASHBOARD_BUNDLE_FILENAME = "dashboard.js";

/** The dashboard stylesheet's filename inside WEBVIEW_DIST_SEGMENTS, emitted beside the bundle from the entry's css import. */
export const DASHBOARD_STYLESHEET_FILENAME = "dashboard.css";
