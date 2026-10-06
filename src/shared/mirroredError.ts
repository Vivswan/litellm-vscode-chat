import * as l10n from "@vscode/l10n";
import { Logger } from "./logger";

/**
 * Compose a two-part error message for surfaces that flatten newlines (GitHub Copilot Chat's error block, VS Code
 * notifications): headline, paragraph break, localized "Details:" lead-in, detail - the lead-in is the visible boundary
 * once the newlines are gone. Discovery-surface messages keep the plain "\n" join, which the dashboard and tooltips
 * split on.
 */
export function chatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\n${l10n.t("Details: {0}", detail)}`;
}

export function englishChatErrorMessage(headline: string, detail: string): string {
	return `${headline}\n\nDetails: ${detail}`;
}

/**
 * The English channel a boundary error must carry; the union makes omitting both a compile error.
 *
 *   englishMessage    -> the full mirror of the localized message; the output channel renders it in the message's place
 *   logClassification -> the terse text PUBLIC surfaces (shared/logger.ts) record; required where the message embeds
 *                        response-derived text, and distinct per site so failure modes stay apart without it
 */
export type EnglishRendering =
	| { readonly englishMessage: string; readonly logClassification?: string }
	| { readonly englishMessage?: string; readonly logClassification: string };

/**
 * Base class for every error whose display message may be localized and that can cross into the status or
 * provider-boundary log path.
 * shared/logger.ts still reads both fields duck-typed, since a logging boundary can be handed anything.
 */
export class MirroredError extends Error {
	readonly englishMessage?: string;
	readonly logClassification?: string;

	/**
	 * Both texts pass the one output door here, once: the display message is user-facing (chat errors, status rows,
	 * tooltips, toasts read it) and the English mirror is its byte-for-byte twin under an English host, so the two
	 * mask alike wherever either is shown.
	 */
	constructor(message: string, options: EnglishRendering & { readonly cause?: unknown }) {
		super(Logger.redact(message), { cause: options.cause });
		this.name = "MirroredError";
		if (options.englishMessage !== undefined) {
			this.englishMessage = Logger.redact(options.englishMessage);
		}
		if (options.logClassification !== undefined) {
			this.logClassification = options.logClassification;
		}
	}
}

export function localizedError(display: string, english: string, logClassification?: string): MirroredError {
	return new MirroredError(display, {
		englishMessage: english,
		...(logClassification !== undefined ? { logClassification } : {}),
	});
}
