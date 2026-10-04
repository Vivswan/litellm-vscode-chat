/**
 * The project's GitHub links, derived from one repository URL so docs deep-links and issue destinations cannot
 * drift apart. Every value is a literal built from literals, and the module imports nothing but a type, so the
 * dashboard may read from here (feedbackLinks.ts, the setup-hint link in serverEditPage.tsx) and still prove
 * from a read of docsLinks.ts plus this file that no link target carries server data.
 */

import type { SetupHintKind } from "../errorClassification";

/** The GitHub repository; issue links and docs anchors derive from it. */
export const GITHUB_REPO_URL = "https://github.com/Vivswan/litellm-vscode-chat";

/** The getting-started guide: where every "Documentation" action lands. */
export const GITHUB_DOCS_URL = `${GITHUB_REPO_URL}/blob/main/docs/getting-started.md`;

/** A pre-labelled feature request; the bug reporter builds its own issue URL from the diagnostics. */
export const GITHUB_FEATURE_REQUEST_URL = `${GITHUB_REPO_URL}/issues/new?labels=enhancement&title=%5BFeature%5D+`;

const GITHUB_TROUBLESHOOTING_DOC = `${GITHUB_REPO_URL}/blob/main/docs/troubleshooting.md` as const;

/**
 * Where each setup hint's "Troubleshooting Docs" action lands, in the host's toasts and gates and in the
 * dashboard's test footer and error banner alike. A Record over the full hint union, so a new hint id fails to
 * compile until it names its docs target; `as const` keeps each value a literal type so the webview's DocsUrl
 * union stays narrow.
 */
export const SETUP_HINT_DOCS_URLS = {
	// The doubled hyphens are github-slugger's rendering of the heading's stripped "/" (leaving a doubled space)
	// and its literal " - " separator.
	"check-base-url": `${GITHUB_TROUBLESHOOTING_DOC}#the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api`,
	"proxy-not-running": `${GITHUB_TROUBLESHOOTING_DOC}#connection-error-unable-to-connect`,
	"configure-api-key": `${GITHUB_TROUBLESHOOTING_DOC}#authentication-failed`,
	// The corrected-URL advice is a bullet of the same connection-error section.
	"use-bare-localhost": `${GITHUB_TROUBLESHOOTING_DOC}#connection-error-unable-to-connect`,
} as const satisfies Record<SetupHintKind, string>;
