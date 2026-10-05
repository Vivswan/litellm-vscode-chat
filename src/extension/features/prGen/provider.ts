import type { CancellationToken } from "vscode";
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
			const parsed = parseTitleAndDescription(await send(buildPrPrompt(context), token));
			if (parsed.kind === "empty") {
				return undefined;
			}
			return parsed.description === undefined
				? { title: parsed.title }
				: { title: parsed.title, description: parsed.description };
		},
	};
}
