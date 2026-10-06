import type { CancellationToken } from "vscode";
import { Logger } from "../../../shared/logger";
import type { TitleAndDescriptionProvider } from "./githubPullRequestsApi";
import { parseTitleAndDescription } from "./parse";
import { buildPrPrompt } from "./prompt";

/**
 * The send function arrives from the wiring already bound to the configured model and the wiring's logging boundary;
 * errors and cancellation propagate to the calling extension untouched. An answer with no usable title maps to
 * `undefined` - the upstream API's "provider could not" value.
 */

export type PrGenerationSend = (prompt: string, token: CancellationToken) => Promise<string>;

export function createTitleAndDescriptionProvider(send: PrGenerationSend): TitleAndDescriptionProvider {
	return {
		async provideTitleAndDescription(context, token) {
			const parsed = parseTitleAndDescription(Logger.redact(await send(buildPrPrompt(context), token)));
			if (parsed.kind === "empty") {
				return undefined;
			}
			// The fields leave the extension here (to the GitHub Pull Requests extension), so each passes the door
			// again: the parse may respell what the reply's own spelling hid from the mask at receipt.
			return parsed.description === undefined
				? { title: Logger.redact(parsed.title) }
				: { title: Logger.redact(parsed.title), description: Logger.redact(parsed.description) };
		},
	};
}
