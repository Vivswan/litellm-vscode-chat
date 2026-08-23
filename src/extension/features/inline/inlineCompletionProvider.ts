/**
 * The inline-completions provider core: debounce, language filter, model
 * gate, cache, one item. The transport is INJECTED (InlineCompletionSend) so
 * this core carries no connection resolution or wire code; the wiring
 * composes it with the real send and registers it only while the feature is
 * enabled. Failures degrade silently to "no suggestion" - ghost text has no
 * error surface - and cancellation is never logged.
 */

import * as vscode from "vscode";
import {
	FIM_PREFIX_BUDGET,
	FIM_SUFFIX_BUDGET,
	truncateFimPrefix,
	truncateFimSuffix,
} from "../../../provider/transport/fim";
import type { FeatureModelRef } from "../../../shared/config/settingSpec";
import { getFeatureModelRef, getInlineLanguageFilter } from "../../../shared/config/settings";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { CompletionCache } from "./completionCache";
import { languageAllowed } from "./languageFilter";

/** Typing pause before any work; the token check after it absorbs bursts. */
export const INLINE_COMPLETION_DEBOUNCE_MS = 200;

export interface InlineCompletionRequest {
	readonly modelRef: FeatureModelRef;
	/** Budget-truncated document context: exactly the cache key's prefix tail. */
	readonly prefix: string;
	/** Budget-truncated document context: exactly the cache key's suffix head. */
	readonly suffix: string;
	readonly token: vscode.CancellationToken;
}

/**
 * The transport seam: resolves the entry connection, applies the resolved
 * record's `_fim_template`, and performs the one non-streaming /completions
 * call. Returns the completion text, or undefined when the response carried
 * none; throws its transport errors (vscode.CancellationError on abort).
 */
export type InlineCompletionSend = (request: InlineCompletionRequest) => Promise<string | undefined>;

export interface InlineCompletionProviderDeps {
	readonly send: InlineCompletionSend;
	/** Owned by the wiring, which invalidates it on model or configuration changes. */
	readonly cache: CompletionCache;
	/**
	 * The extension's output-channel logger; English-only lines. The provider
	 * runs on every keystroke, so it deduplicates its own lines once per
	 * session per class - an unbounded per-invocation line would evict the
	 * real errors from the issue-report buffer.
	 */
	readonly log: (message: string, data?: unknown) => void;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Total cancellation test: a hostile error whose prototype walk throws must degrade, not reject. */
function isCancellation(error: unknown): boolean {
	try {
		return error instanceof vscode.CancellationError;
	} catch {
		return false;
	}
}

class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	/**
	 * Advisory classes already logged; every line below goes through adviseOnce,
	 * so none can recur per keystroke. Deliberately a once-latch rather than
	 * Logger.advisory: advisory() only protects the issue-report buffer, and a
	 * provider running on every keystroke would still flood the CHANNEL with one
	 * line per keystroke - while a send failure is a real once-per-session error
	 * that belongs in the buffer exactly once per failure class.
	 */
	private readonly advised = new Set<string>();

	constructor(private readonly deps: InlineCompletionProviderDeps) {}

	private adviseOnce(key: string, message: string, data?: unknown): void {
		if (this.advised.has(key)) {
			return;
		}
		this.advised.add(key);
		this.deps.log(message, data);
	}

	/**
	 * A settings getter's advisory sink, deduplicated per setting scope AND
	 * message: one setting's malformed value must not silence another's
	 * advisory (the line itself stays the getter's own wording).
	 */
	private settingsLog(scope: string): (message: string, data?: unknown) => void {
		return (message, data) => {
			this.adviseOnce(`${scope}:${message}`, message, data);
		};
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		await sleep(INLINE_COMPLETION_DEBOUNCE_MS);
		if (token.isCancellationRequested) {
			return undefined;
		}

		const filter = getInlineLanguageFilter(this.settingsLog("languageFilter"));
		if (!languageAllowed(document.languageId, filter)) {
			return undefined;
		}

		const modelRef = getFeatureModelRef("inlineCompletions", this.settingsLog("model"));
		if (modelRef === undefined) {
			this.adviseOnce(
				"model-unset",
				"Inline completions are enabled but litellm-vscode-chat.inlineCompletions.model is not set; no completion requests will be sent"
			);
			return undefined;
		}

		// Bounded reads through the shared truncation pipeline: one unit past
		// each budget so a cut landing inside a surrogate pair is visible and
		// repaired here, exactly as the transport's own truncation would - the
		// cache key and the wire prefix stay one string by construction.
		const offset = document.offsetAt(position);
		const prefix = truncateFimPrefix(
			document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - (FIM_PREFIX_BUDGET + 1))), position))
		);
		const suffix = truncateFimSuffix(
			document.getText(new vscode.Range(position, document.positionAt(offset + FIM_SUFFIX_BUDGET + 1)))
		);

		const key = { server: modelRef.server, model: modelRef.model, prefix, suffix };
		const cached = this.deps.cache.get(key);
		if (cached !== undefined) {
			return cached === "" ? undefined : [new vscode.InlineCompletionItem(cached)];
		}

		let text: string | undefined;
		try {
			text = await this.deps.send({ modelRef, prefix, suffix, token });
		} catch (error) {
			if (!isCancellation(error)) {
				// Once per failure class: a server that stays down must not write a
				// line per keystroke while distinct failure kinds stay visible.
				const label = errorLabel(error);
				this.adviseOnce(`send-failed:${label}`, "Inline completion request failed", { error: label });
			}
			return undefined;
		}
		if (text === undefined) {
			// A response without usable text is transient (malformed body); leave
			// the cache alone so the next keystroke may try again.
			return undefined;
		}
		this.deps.cache.set(key, text);
		if (text === "" || token.isCancellationRequested) {
			return undefined;
		}
		return [new vscode.InlineCompletionItem(text)];
	}
}

/** The wiring's one constructor; registration stays with the caller. */
export function createInlineCompletionProvider(
	deps: InlineCompletionProviderDeps
): vscode.InlineCompletionItemProvider {
	return new InlineCompletionProvider(deps);
}
