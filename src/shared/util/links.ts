/**
 * The project's GitHub links, derived from one repository URL so docs
 * deep-links and issue destinations cannot drift apart.
 */

import type { SetupHintKind } from "../errorClassification";

/** The GitHub repository; issue links and docs anchors derive from it. */
export const GITHUB_REPO_URL = "https://github.com/Vivswan/litellm-vscode-chat";

/** The getting-started guide: where every "Documentation" action lands. */
export const GITHUB_DOCS_URL = `${GITHUB_REPO_URL}/blob/main/docs/getting-started.md`;

const GITHUB_TROUBLESHOOTING_DOC = `${GITHUB_REPO_URL}/blob/main/docs/troubleshooting.md`;

/**
 * Where each setup hint's "Troubleshooting Docs" action lands. A Record over
 * the full hint union, so a new hint id fails to compile until it names its
 * docs target. Host-side only: the webview ships its own literal copies in
 * docsLinks.ts, cross-pinned by test.
 */
export const SETUP_HINT_DOCS_URLS: Record<SetupHintKind, string> = {
	// The doubled hyphens are github-slugger's rendering of the heading's
	// stripped "/" (leaving a doubled space) and its literal " - " separator.
	"check-base-url": `${GITHUB_TROUBLESHOOTING_DOC}#the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api`,
	"proxy-not-running": `${GITHUB_TROUBLESHOOTING_DOC}#connection-error-unable-to-connect`,
	"configure-api-key": `${GITHUB_TROUBLESHOOTING_DOC}#authentication-failed`,
};
