/**
 * The repository URL is package.json's `repository.url`, read as the build-time constant `__LITELLM_REPOSITORY_URL__`:
 * scripts/dev/bundle.mts defines it for both bundles from the manifest, and the two test runners set the same global
 * from the same field (src/test/util/buildDefines.ts) because they load the source unbundled.
 *
 * Every other value is a literal built on that constant or on the docs origin, and the module imports nothing but a
 * type, so the dashboard may read from here (feedbackLinks.ts, diagnostics.tsx, the setup-hint link in
 * serverEditPage.tsx) and still prove from a read of docsLinks.ts plus this file that no link target carries server
 * data.
 *
 *   the GitHub repository, which issue links derive from, and the published docs site, which every docs deep-link
 *   derives from                                             -> neither family can drift apart
 *   Without the define the bare identifier throws at module load, naming itself -> there is deliberately no fallback
 *                                                                                   spelling
 */

import type { SetupHintKind } from "../errorClassification";

declare const __LITELLM_REPOSITORY_URL__: string;

export const GITHUB_REPO_URL: string = __LITELLM_REPOSITORY_URL__;

/** The value is the Pages URL as GitHub assigns it, a literal: nothing from a server ever interpolates here. */
export const DOCS_SITE_URL = "https://vivswan.github.io/litellm-vscode-chat";

/**
 * Heading ids on the site are GitHub's (the site build slugs with github-slugger), so an anchor that reaches a heading
 * on the GitHub page reaches the same heading on the site. The overloads carry literal arguments through to the return
 * type, so a constant built from literals stays a literal type and the webview's DocsUrl union keeps rejecting a
 * string built at runtime.
 */
export function docsUrl<P extends string>(page: P): `${typeof DOCS_SITE_URL}/${P}.html`;
export function docsUrl<P extends string, A extends string>(
	page: P,
	anchor: A
): `${typeof DOCS_SITE_URL}/${P}.html#${A}`;
export function docsUrl(page: string, anchor?: string): string {
	return `${DOCS_SITE_URL}/${page}.html${anchor === undefined ? "" : `#${anchor}`}`;
}

/** The getting-started guide: where every "Documentation" action lands, in the host's menus and the dashboard alike. */
export const DOCS_GETTING_STARTED_URL = docsUrl("getting-started");

/** A pre-labelled feature request; the bug reporter builds its own issue URL from the diagnostics. */
export const GITHUB_FEATURE_REQUEST_URL = `${GITHUB_REPO_URL}/issues/new?labels=enhancement&title=%5BFeature%5D+`;

/**
 * Where each setup hint's "Troubleshooting Docs" action lands, in the host's toasts and gates and in the dashboard's
 * test footer and error banner alike. A Record over the full hint union, so a new hint id fails to compile until it
 * names its docs target; `as const` keeps each value a literal type so the webview's DocsUrl union stays narrow.
 */
export const SETUP_HINT_DOCS_URLS = {
	// The doubled hyphens are github-slugger's rendering of the heading's stripped "/" (leaving a doubled space)
	// and its literal " - " separator.
	"check-base-url": docsUrl(
		"troubleshooting",
		"the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api"
	),
	"proxy-not-running": docsUrl("troubleshooting", "connection-error-unable-to-connect"),
	"configure-api-key": docsUrl("troubleshooting", "authentication-failed"),
	// The corrected-URL advice is a bullet of the same connection-error section.
	"use-bare-localhost": docsUrl("troubleshooting", "connection-error-unable-to-connect"),
} as const satisfies Record<SetupHintKind, string>;
