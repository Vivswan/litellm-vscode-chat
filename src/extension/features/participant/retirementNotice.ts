/**
 * VS Code is retiring chat participants, so until this one is removed its command listing and each session's first
 * completed answer end with where to go instead. The wiring records that in the turn's result metadata, which the host
 * hands back with the history: which answers carry the notice is read from there, never from their text, so a session
 * resumed in another display language still counts and still cuts it.
 */
import * as l10n from "@vscode/l10n";
import { SKILL_NAME } from "../../../shared/config/commandIds";

/** Opens the notice's block. The notice is the last thing a turn reports, so the last rule in a marked answer is ours. */
const RULE = "\n\n---\n\n";

const METADATA_KEY = "retirementNotice";

/** The notice as a turn appends it: its own block under a rule, reading as the extension's words, not the model's. */
export function retirementNotice(): string {
	const notice = l10n.t(
		"`@litellm` goes away in January 2027, because VS Code is retiring chat participants. Ask in chat with one of your LiteLLM models picked instead, and type `/{0}` for help with your LiteLLM setup.",
		SKILL_NAME
	);
	return `${RULE}${notice}`;
}

/** The result metadata of a turn, saying whether its answer ends with the notice. */
export function retirementMetadata(noticed: boolean): { readonly retirementNotice: boolean } {
	return { [METADATA_KEY]: noticed };
}

/** Whether a response turn's answer ends with the notice. */
export function carriesRetirementNotice(turn: { readonly result?: { readonly metadata?: unknown } }): boolean {
	const metadata = turn.result?.metadata;
	return (
		typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>)[METADATA_KEY] === true
	);
}

/** A marked answer without its notice; a model that reads the notice back as its own words starts writing it. */
export function withoutRetirementNotice(answer: string): string {
	const rule = answer.lastIndexOf(RULE);
	return rule === -1 ? answer : answer.slice(0, rule);
}
