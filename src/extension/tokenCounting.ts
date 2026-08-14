import type { TokenEstimationMode } from "../shared/config/settingSpec";
import { setTextTokenCounting } from "../shared/conversion/textTokens";

/** The gpt-tokenizer encodings the chat.tokenEstimation setting can name. */
export type TokenizerEncoding = "o200k_base" | "cl100k_base";

/** What a loaded encoding must offer; gpt-tokenizer's per-encoding entry points satisfy it structurally. */
export interface LoadedTokenizer {
	readonly countTokens: (text: string, options?: { readonly allowedSpecial?: "all" }) => number;
}

export interface TokenCountingDeps {
	/** Fixed English text plus enum-ish data only: both lines feed the issue-report buffer. */
	readonly log: (message: string, data?: unknown) => void;
	readonly logError: (message: string, error: unknown) => void;
	/** The host UI language (vscode.env.language); a non-English UI preloads o200k_base in auto mode. */
	readonly uiLanguage: string;
	/** Test seam; the default dynamic import pulls the encoding's lazy bundle chunk. */
	readonly loadEncoding?: (encoding: TokenizerEncoding) => Promise<LoadedTokenizer>;
}

/**
 * Two literal specifiers rather than one template string: the bundler can
 * only split what it can resolve statically, and each encoding must become
 * its own lazy chunk (the rank data is megabytes that the eager bundle and
 * activation path never pay for; CI pins the chunk layout).
 */
function importEncoding(encoding: TokenizerEncoding): Promise<LoadedTokenizer> {
	return encoding === "o200k_base"
		? import("gpt-tokenizer/encoding/o200k_base")
		: import("gpt-tokenizer/encoding/cl100k_base");
}

/** "en" and its regional variants; anything else counts as a non-English UI. */
function isEnglishUiLanguage(language: string): boolean {
	const lower = language.toLowerCase();
	return lower === "en" || lower.startsWith("en-");
}

export interface TokenCountingController {
	/** Apply a (re-)read chat.tokenEstimation mode; called at activation and on configuration change. */
	readonly applyMode: (mode: TokenEstimationMode) => void;
}

/**
 * Owns the async side of token estimation: which counting mode the shared
 * counter (shared/conversion/textTokens.ts) runs in, and when an encoding's
 * rank data actually loads. Counting itself stays synchronous throughout -
 * a mode that wants a tokenizer counts by its heuristic until the load lands,
 * and a failed load logs once and leaves that heuristic standing, so nothing
 * here can ever throw into the request path.
 *
 * Load policy per mode: "heuristic" never loads; the explicit encodings load
 * eagerly on apply; "auto" loads o200k_base eagerly under a non-English UI
 * and otherwise waits for the counter's non-Latin detection to fire. Each
 * applied mode gets at most one load attempt (successful loads are cached
 * across mode changes), and a load that resolves after the mode changed
 * installs nothing.
 */
export function createTokenCountingController(deps: TokenCountingDeps): TokenCountingController {
	const loadEncoding = deps.loadEncoding ?? importEncoding;
	const loaded = new Map<TokenizerEncoding, LoadedTokenizer>();
	let generation = 0;

	const install = (tokenizer: LoadedTokenizer): void => {
		// allowedSpecial "all": special-token text ("<|endoftext|>") is ordinary
		// user text here and must count, not throw (gpt-tokenizer's default
		// throws on it; the counter also contains a throw as its backstop).
		setTextTokenCounting({
			kind: "tokenizer",
			countTokens: (text) => tokenizer.countTokens(text, { allowedSpecial: "all" }),
		});
	};

	const startLoad = (encoding: TokenizerEncoding, appliedGeneration: number): void => {
		const cached = loaded.get(encoding);
		if (cached !== undefined) {
			install(cached);
			return;
		}
		loadEncoding(encoding).then(
			(tokenizer) => {
				loaded.set(encoding, tokenizer);
				if (generation === appliedGeneration) {
					install(tokenizer);
					deps.log("Token estimation tokenizer loaded", { encoding });
				}
			},
			(error: unknown) => {
				if (generation === appliedGeneration) {
					deps.logError("Token estimation tokenizer load failed; the heuristic estimate stays active", error);
				}
			}
		);
	};

	const applyMode = (mode: TokenEstimationMode): void => {
		generation += 1;
		const appliedGeneration = generation;
		switch (mode) {
			case "heuristic":
				setTextTokenCounting({ kind: "heuristic" });
				return;
			case "o200k_base":
			case "cl100k_base":
				// The plain heuristic covers the load window (and a failed load).
				setTextTokenCounting({ kind: "heuristic" });
				startLoad(mode, appliedGeneration);
				return;
			case "auto": {
				let triggered = false;
				setTextTokenCounting({
					kind: "adaptive",
					onNonLatinDetected: () => {
						if (!triggered && generation === appliedGeneration) {
							triggered = true;
							startLoad("o200k_base", appliedGeneration);
						}
					},
				});
				if (!isEnglishUiLanguage(deps.uiLanguage)) {
					triggered = true;
					startLoad("o200k_base", appliedGeneration);
				}
				return;
			}
			default: {
				mode satisfies never;
				return;
			}
		}
	};

	return { applyMode };
}
