/**
 * The project's GitHub links, derived from one repository URL so docs deep-links and issue destinations cannot
 * drift apart. The repository URL is package.json's `repository.url`, read as the build-time constant
 * `__LITELLM_REPOSITORY_URL__`: scripts/dev/bundle.mts defines it for both bundles from the manifest, and the two
 * test runners set the same global from the same field (src/test/util/buildDefines.ts) because they load the
 * source unbundled. Every other value is a literal built on that constant, and the module imports nothing but a
 * type, so the dashboard may read from here (feedbackLinks.ts, the setup-hint link in serverEditPage.tsx) and
 * still prove from a read of docsLinks.ts plus this file that no link target carries server data. Without the
 * define the bare identifier throws at module load, naming itself: there is deliberately no fallback spelling.
 */

import type { SetupHintKind } from "../errorClassification";

/** Supplied by the bundler's define or the test bootstrap; never assigned in source. */
declare const __LITELLM_REPOSITORY_URL__: string;

/** The GitHub repository; issue links and docs anchors derive from it. */
export const GITHUB_REPO_URL: string = __LITELLM_REPOSITORY_URL__;

/** The getting-started guide: where every "Documentation" action lands. */
export const GITHUB_DOCS_URL = `${GITHUB_REPO_URL}/blob/main/docs/getting-started.md`;

/** A pre-labelled feature request; the bug reporter builds its own issue URL from the diagnostics. */
export const GITHUB_FEATURE_REQUEST_URL = `${GITHUB_REPO_URL}/issues/new?labels=enhancement&title=%5BFeature%5D+`;

declare const setupHintDocsUrl: unique symbol;

/**
 * A troubleshooting anchor built in this file and nowhere else. A brand rather than a literal type, because the
 * repository URL arrives as a plain string and the webview's DocsUrl must still reject a string built at runtime.
 */
type SetupHintDocsUrl = string & { readonly [setupHintDocsUrl]: true };

/** The troubleshooting guide's section `anchor`, as github-slugger renders the heading. */
function troubleshootingAnchor(anchor: string): SetupHintDocsUrl {
	return `${GITHUB_REPO_URL}/blob/main/docs/troubleshooting.md#${anchor}` as SetupHintDocsUrl;
}

/**
 * Where each setup hint's "Troubleshooting Docs" action lands, in the host's toasts and gates and in the
 * dashboard's test footer and error banner alike. A Record over the full hint union, so a new hint id fails to
 * compile until it names its docs target; the branded values are what the webview's DocsUrl union admits.
 */
export const SETUP_HINT_DOCS_URLS = {
	// The doubled hyphens are github-slugger's rendering of the heading's stripped "/" (leaving a doubled space)
	// and its literal " - " separator.
	"check-base-url": troubleshootingAnchor(
		"the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api"
	),
	"proxy-not-running": troubleshootingAnchor("connection-error-unable-to-connect"),
	"configure-api-key": troubleshootingAnchor("authentication-failed"),
	// The corrected-URL advice is a bullet of the same connection-error section.
	"use-bare-localhost": troubleshootingAnchor("connection-error-unable-to-connect"),
} satisfies Record<SetupHintKind, SetupHintDocsUrl>;
