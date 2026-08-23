import { truncateKeepingHead } from "../../../shared/util/text";
import type { TitleAndDescriptionProvider } from "./githubPullRequestsApi";

/**
 * The PR title-and-description prompt assembly: pure normalization of the
 * GitHub Pull Requests generation context into one model prompt. No vscode
 * imports beyond the vendored API types (erased), no transport, no UI: the
 * provider beside it sends the prompt and parses the one-shot answer.
 */

/** The GHPR-provided generation context, derived from the vendored provider signature so the two cannot drift. */
export type TitleAndDescriptionContext = Parameters<TitleAndDescriptionProvider["provideTitleAndDescription"]>[0];

/** Head-truncation bound for the joined patch blocks; everything past it is noise for a title and a short description. */
export const PATCHES_CHAR_LIMIT = 120_000;

/**
 * How many of the branch's commit messages ride along. An over-long list is
 * thinned from the MIDDLE rather than from one end, so which messages survive
 * does not depend on knowing which end is the recent one - the upstream
 * context's order is inferred, and an inference must not decide content.
 */
export const COMMIT_MESSAGE_COUNT = 20;

/** Head-truncation bound for the joined commit messages (merge-heavy branches carry huge bodies). */
export const COMMIT_MESSAGES_CHAR_LIMIT = 8_000;

/** Head-truncation bound for the user's PR template. */
export const TEMPLATE_CHAR_LIMIT = 10_000;

/** Head-truncation bound for the joined referenced-issue blocks. */
export const ISSUES_CHAR_LIMIT = 10_000;

/**
 * The instruction heading every prompt; the parse module's Title:/Description:
 * grammar is the answer shape this asks for. Model-facing text, so it stays
 * English by policy.
 */
export const BUILT_IN_PR_INSTRUCTION = [
	"Write a pull request title and description for the change in the patches below.",
	"The title is one line like a commit subject: at most about 72 characters, in the imperative mood.",
	"The description is short markdown saying what the change does and why.",
	"Answer in exactly this form, with no markdown fences and no commentary:",
	"Title: <the title>",
	"Description:",
	"<the description>",
].join("\n");

/**
 * Head-truncate at `limit` characters, marking the cut with a bracketed label
 * line. The cut itself is the shared truncateKeepingHead, so a severed
 * surrogate pair never reaches the JSON request body.
 */
function headTruncated(text: string, limit: number, label: string): string {
	return text.length > limit ? `${truncateKeepingHead(text, limit)}\n[${label} truncated]` : text;
}

/**
 * The longest common directory prefix (through its final slash) of the object
 * patches' URIs; File: headers strip it because the absolute URIs GHPR hands
 * over would ship the user's directory layout to the server.
 */
function commonDirPrefix(uris: readonly string[]): string {
	let prefix = uris[0];
	if (prefix === undefined) {
		return "";
	}
	for (const uri of uris) {
		let i = 0;
		while (i < prefix.length && i < uri.length && prefix[i] === uri[i]) {
			i++;
		}
		prefix = prefix.slice(0, i);
	}
	return prefix.slice(0, prefix.lastIndexOf("/") + 1);
}

/** A Windows drive-letter segment, plain or percent-encoded, in either case. */
const DRIVE_SEGMENT = /^[a-z](?::|%3a)$/i;

/**
 * Whether the prefix names a real shared directory rather than a bare URI
 * root or a top-level one: mixed-root patches collapse to "file:///" or
 * "scheme://authority/", and stripping only that would still ship the layout.
 * A single top-level segment does not count either - "file:///Users/" would
 * leave the account name as the first path segment of every File: header, so
 * the shared path must reach at least two segments deep. A Windows drive
 * letter is root metadata rather than one of those segments: counting "C:"
 * would let "file:///C:/Users/" through, which is the same leak.
 */
function isSharedDirectory(prefix: string): boolean {
	const schemeEnd = prefix.indexOf("://");
	const path = schemeEnd === -1 ? prefix : prefix.slice(schemeEnd + 3).replace(/^[^/]*/, "");
	const segments = path.split("/").filter((segment) => segment !== "" && !DRIVE_SEGMENT.test(segment));
	return segments.length >= 2;
}

/** The last non-empty /-segment; the fail-closed stand-in when no shared directory can be stripped. */
function baseName(uri: string): string {
	const segments = uri.split("/").filter((segment) => segment !== "");
	return segments[segments.length - 1] ?? uri;
}

/**
 * One text block per patch, across both shapes of the upstream union: plain
 * strings ride verbatim, object patches gain a File: header naming the file
 * (and the previous name when the change is a rename), relativized against
 * the patches' common directory prefix - basenames when there is none.
 */
function patchBlocks(patches: TitleAndDescriptionContext["patches"]): string[] {
	const uris = patches.flatMap((entry) =>
		typeof entry === "string"
			? []
			: [entry.fileUri, ...(entry.previousFileUri === undefined ? [] : [entry.previousFileUri])]
	);
	const prefix = commonDirPrefix(uris);
	const shared = isSharedDirectory(prefix);
	const named = (uri: string): string => {
		const relative = shared ? uri.slice(prefix.length) : "";
		return relative === "" ? baseName(uri) : relative;
	};
	return patches.map((entry) => {
		if (typeof entry === "string") {
			return entry;
		}
		const name = named(entry.fileUri);
		const previous = entry.previousFileUri === undefined ? undefined : named(entry.previousFileUri);
		const renamed = previous !== undefined && previous !== name ? ` (renamed from ${previous})` : "";
		return `File: ${name}${renamed}\n${entry.patch}`;
	});
}

/**
 * At most COMMIT_MESSAGE_COUNT messages, thinned from the middle when there
 * are more: both ends of the list survive, so the selection is the same
 * whichever end holds the recent commits. The elision is marked so the model
 * does not read the two halves as consecutive.
 */
function boundedMessages(messages: readonly string[]): string[] {
	if (messages.length <= COMMIT_MESSAGE_COUNT) {
		return [...messages];
	}
	const head = Math.ceil(COMMIT_MESSAGE_COUNT / 2);
	const tail = COMMIT_MESSAGE_COUNT - head;
	const omitted = messages.length - COMMIT_MESSAGE_COUNT;
	return [
		...messages.slice(0, head),
		`[${omitted} more commit ${omitted === 1 ? "message" : "messages"} omitted]`,
		...messages.slice(messages.length - tail),
	];
}

/**
 * The character bound, spent ACROSS the messages that survived the count bound
 * rather than by truncating the joined text. Head-truncating the join would
 * keep whichever end came first and so would put the whole selection back at
 * the mercy of the inferred order - the thing the middle thinning above exists
 * to prevent.
 *
 * The share-out is water-filling: shortest first, each message offered an equal
 * share of what is left and taking only what it needs, so the surplus short
 * messages leave behind goes to the long ones. A list that already fits is
 * returned untouched, and a lone message gets the whole budget. Every cap
 * depends only on the multiset of lengths, never on position, so reversing the
 * list changes the order and nothing else.
 */
function charBoundedMessages(messages: readonly string[]): string[] {
	// The blank line between messages is part of the assembled section, so the
	// budget pays for it too - on BOTH paths, or the limit would bound the
	// messages on one of them but not the text actually sent.
	const budget = COMMIT_MESSAGES_CHAR_LIMIT - Math.max(0, messages.length - 1) * "\n\n".length;
	const total = messages.reduce((sum, message) => sum + message.length, 0);
	if (messages.length === 0 || total <= budget) {
		return [...messages];
	}
	// The marker a cut message carries must fit INSIDE its share, or the limit
	// would not be the bound this function claims.
	const marker = "\n[commit messages truncated]".length;
	const caps = new Array<number>(messages.length).fill(0);
	const shortestFirst = messages
		.map((_message, index) => index)
		.sort((a, b) => (messages[a]?.length ?? 0) - (messages[b]?.length ?? 0));
	let left = budget;
	let unassigned = messages.length;
	for (const index of shortestFirst) {
		const share = Math.floor(left / unassigned);
		const length = messages[index]?.length ?? 0;
		// A message that fits its share whole costs exactly itself; one that must
		// be cut pays for its own marker out of the same share.
		const take = length <= share ? length : Math.max(0, share - marker);
		caps[index] = take;
		left -= length <= share ? length : take + marker;
		unassigned -= 1;
	}
	return messages.map((message, index) => headTruncated(message, caps[index] ?? 0, "commit messages"));
}

/**
 * Assemble the model prompt from the GHPR context: instruction, the PR
 * template when present, branch name, the bounded commit messages,
 * referenced issues, and the patches. Empty sections stay out.
 */
export function buildPrPrompt(context: TitleAndDescriptionContext): string {
	const sections = [BUILT_IN_PR_INSTRUCTION];
	const template = context.template ?? "";
	if (template.trim() !== "") {
		sections.push(
			`Structure the description to follow this pull request template:\n${headTruncated(template, TEMPLATE_CHAR_LIMIT, "template")}`
		);
	}
	const branch = context.compareBranch ?? "";
	if (branch.trim() !== "") {
		sections.push(`Branch name: ${branch}`);
	}
	const messages = charBoundedMessages(
		boundedMessages(context.commitMessages.map((message) => message.trim()).filter((message) => message !== ""))
	);
	if (messages.length > 0) {
		sections.push(`Commit messages on this branch, as content and style context:\n${messages.join("\n\n")}`);
	}
	const issues = (context.issues ?? []).map((issue) => `${issue.reference}:\n${issue.content}`);
	if (issues.length > 0) {
		sections.push(
			`Issues referenced by the change:\n${headTruncated(issues.join("\n\n"), ISSUES_CHAR_LIMIT, "issues")}`
		);
	}
	const patches = patchBlocks(context.patches).join("\n\n");
	if (patches.trim() !== "") {
		sections.push(`Patches:\n${headTruncated(patches, PATCHES_CHAR_LIMIT, "patches")}`);
	}
	return sections.join("\n\n");
}
