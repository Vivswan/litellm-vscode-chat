/**
 * The bundle script and the dashboard panel both derive the path from these segments, so the two cannot drift. Pure
 * constants: no vscode, no Node (the bundle script imports this file outside the extension host).
 */

export const WEBVIEW_DIST_SEGMENTS = ["dist", "webview"] as const;

export const DASHBOARD_BUNDLE_FILENAME = "dashboard.js";

/** Emitted beside the bundle from the entry's css import. */
export const DASHBOARD_STYLESHEET_FILENAME = "dashboard.css";
