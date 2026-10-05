/**
 * Allowlist, not denylist: the package is a small known file set, and a denylist only catches leaks someone predicted
 * (the repo-tooling files it missed shipped in a VSIX before anyone noticed). A new asset type or localization catalog
 * is added here deliberately.
 */
const ALLOWED_PACKAGED_FILE =
	/^(package\.json|README\.md|CHANGELOG\.md|LICENSE\.md|ThirdPartyNotices\.txt|dist\/extension\.js|dist\/chunks\/[A-Za-z0-9_.-]+\.js|dist\/webview\/dashboard\.js|dist\/webview\/dashboard\.css|dist\/openrouter-models\.json)$|^assets\/.+\.(png|md)$|^package\.nls(\.[A-Za-z0-9_-]+)?\.json$|^l10n\/bundle\.l10n(\.[A-Za-z0-9_-]+)?\.json$/;

/**
 * Without package.nls.json the host renders raw %key% placeholders; without the English bundle vscode.l10n and the
 * webview injection have nothing to read.
 */
export const REQUIRED_PACKAGED_FILES = [
	"dist/extension.js",
	"dist/webview/dashboard.js",
	"dist/webview/dashboard.css",
	"package.nls.json",
	"l10n/bundle.l10n.json",
	"ThirdPartyNotices.txt",
] as const;

export function listingProblems(listing: readonly string[], required: readonly string[]): string[] {
	const problems: string[] = [];
	const outside = listing.filter((file) => !ALLOWED_PACKAGED_FILE.test(file));
	if (outside.length > 0) {
		problems.push(`vsce would package files outside the allowed set: ${outside.join(", ")}`);
	}
	const listed: ReadonlySet<string> = new Set(listing);
	for (const file of required) {
		if (!listed.has(file)) {
			problems.push(`${file} is missing from the packaged file list`);
		}
	}
	return problems;
}

export interface SizeLimit {
	readonly bytes: number;
	readonly reason: string;
}

export interface SizeBound {
	readonly file: string;
	readonly min?: SizeLimit;
	readonly max?: SizeLimit;
}

/**
 * Byte bounds on build output no test suite loads, set against a fresh production `bun run bundle` (the test entry
 * points rebuild dist as an unminified development bundle, which these bounds are not written for).
 *
 *   dist/extension.js          561,000 bytes (2026-08-13)  -> ceiling: each encoding's ranks alone are 1-2 MB
 *   dist/chunks/*_base.js      the rank data itself        -> floors: the ranks shipped
 *   dist/webview/dashboard.js  487,104 bytes (2026-08-13)  -> floor: a truncated emit; ceiling: zod once quadrupled it
 *   dist/webview/dashboard.css  80,769 bytes (2026-08-13)  -> floor: a truncated emit or a missing leg; ceiling: a scan
 *                                                             gone wide
 */
export const SIZE_BOUNDS: readonly SizeBound[] = [
	{
		file: "dist/extension.js",
		max: { bytes: 1_200_000, reason: "the tokenizer ranks look inlined into the eager bundle" },
	},
	{ file: "dist/chunks/o200k_base.js", min: { bytes: 1_500_000, reason: "too small to carry its rank data" } },
	{ file: "dist/chunks/cl100k_base.js", min: { bytes: 700_000, reason: "too small to carry its rank data" } },
	{
		file: "dist/webview/dashboard.js",
		min: { bytes: 350_000, reason: "the dashboard bundle looks broken" },
		max: { bytes: 700_000, reason: "a heavy dependency has landed in the webview graph" },
	},
	{
		file: "dist/webview/dashboard.css",
		min: { bytes: 55_000, reason: "the dashboard stylesheet looks broken" },
		max: { bytes: 120_000, reason: "the stylesheet emit has run away" },
	},
];

export function sizeProblem(bound: SizeBound, size: number): string | null {
	if (bound.min !== undefined && size < bound.min.bytes) {
		return `${bound.file} is only ${size} bytes; ${bound.min.reason}`;
	}
	if (bound.max !== undefined && size > bound.max.bytes) {
		return `${bound.file} is ${size} bytes; ${bound.max.reason}`;
	}
	return null;
}

/**
 * The tokenizer rank data rides the lazy chunks, never the eager entry: scripts/dev/bundle.mts splits them into
 * dist/chunks/ and dist/extension.js reaches each only through the deferred `.then(()=>require(...))` thunk. A
 * top-level require, an eagerly evaluated `then(require(...))`, or a bundler that changes the emitted shape fails here
 * rather than passing unproven. The activation-side twin is src/test/activation/production.test.ts.
 */
const LAZY_CHUNKS = ["o200k_base", "cl100k_base"] as const;

export function lazyEdgeProblems(entrySource: string): string[] {
	const problems: string[] = [];
	for (const chunk of LAZY_CHUNKS) {
		const reference = `chunks/${chunk}.js`;
		const occurrences = entrySource.split(reference).length - 1;
		if (occurrences !== 1) {
			problems.push(
				`dist/extension.js references ${reference} ${occurrences} times (expected exactly the one lazy edge)`
			);
		}
		if (!new RegExp(`then\\(\\(\\) ?=> ?require\\("\\./chunks/${chunk}\\.js"\\)\\)`).test(entrySource)) {
			problems.push(`dist/extension.js's reference to ${reference} is not the deferred then(()=>require(...)) thunk`);
		}
	}
	return problems;
}

/**
 * Wire method names from src/dashboard/endpoints.ts, never UI copy: a copy marker fails on a redesign with the build
 * healthy (the dashboard's visible title once did), a method name only when the protocol breaks. Spread across
 * surfaces (server save, secret prefill, usage settings) so one dead tree cannot pass.
 */
const DASHBOARD_MARKERS = ["setUsageAlertThresholds", "readInlineSecrets", "saveServerSetting"] as const;

/**
 * The bundle's NODE_ENV define decides which React build ships, and the size floor would pass a development build:
 * the define must have replaced every process.env.NODE_ENV read, and React's dev-only warning text must be gone.
 */
const DEVELOPMENT_BUILD_MARKERS = ["process.env.NODE_ENV", "Each child in a list"] as const;

/** Every rule reads the host's theme tokens, and the semantic --primary token exists only if the Tailwind leg ran. */
const STYLESHEET_MARKERS = ["var(--vscode-", "--primary"] as const;

export function dashboardMarkerProblems(script: string): string[] {
	const problems: string[] = [];
	for (const marker of DASHBOARD_MARKERS) {
		if (!script.includes(marker)) {
			problems.push(`dist/webview/dashboard.js lacks '${marker}'; the dashboard did not compile into the bundle`);
		}
	}
	for (const marker of DEVELOPMENT_BUILD_MARKERS) {
		if (script.includes(marker)) {
			problems.push(
				`dist/webview/dashboard.js contains '${marker}'; the production bundle looks like a development build`
			);
		}
	}
	return problems;
}

export function stylesheetMarkerProblems(stylesheet: string): string[] {
	const problems: string[] = [];
	if (!stylesheet.includes(STYLESHEET_MARKERS[0])) {
		problems.push("dist/webview/dashboard.css lacks the host theme tokens; the real stylesheet did not bundle");
	}
	if (!stylesheet.includes(STYLESHEET_MARKERS[1])) {
		problems.push("dist/webview/dashboard.css lacks the Tailwind theme block; the Tailwind bundle leg did not run");
	}
	return problems;
}

/**
 * The shipped catalog must carry a real model set (a size floor alone cannot catch a semantically empty file) and
 * no pricing: LiteLLM is the only pricing source, so a pricing key means the slim encoder regressed or a stale file
 * slipped into the package. An entry that is not an object is refused rather than counted.
 */
export function catalogProblems(catalog: unknown, floor: number): string[] {
	const data = (catalog as { data?: unknown } | null)?.data;
	const entries: readonly unknown[] = Array.isArray(data) ? data : [];
	const models = entries.filter(
		(entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)
	);
	const problems: string[] = [];
	if (models.length !== entries.length) {
		problems.push(`dist/openrouter-models.json has ${entries.length - models.length} entries that are not objects`);
	}
	if (models.length < floor) {
		problems.push(`dist/openrouter-models.json parses to ${models.length} models (floor ${floor})`);
	}
	if (models.some((model) => "pricing" in model)) {
		problems.push("dist/openrouter-models.json carries pricing keys; the catalog is capabilities-only");
	}
	return problems;
}
