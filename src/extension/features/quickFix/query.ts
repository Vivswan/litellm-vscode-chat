/**
 * Pure query core for the quick-fix feature: which diagnostics an action
 * claims, the chat query the action opens, and the model-facing fallback
 * prompt (English by policy) when the chat surface is unavailable. Structural
 * shapes only - no vscode import - so the bun tree pins every behavior.
 */

import { truncateKeepingHead } from "../../../shared/util/text";

export interface QuickFixPosition {
	readonly line: number;
	readonly character: number;
}

export interface QuickFixRange {
	readonly start: QuickFixPosition;
	readonly end: QuickFixPosition;
}

/**
 * Structural subset of vscode.Diagnostic: severity follows the host's
 * DiagnosticSeverity numbering (0 Error, 1 Warning, 2 Information, 3 Hint),
 * and `code` admits the host's `{ value, target }` object form plus the null
 * that third-party providers ship despite the host typing.
 */
export interface QuickFixDiagnostic {
	readonly message: string;
	readonly range: QuickFixRange;
	readonly severity: number;
	readonly source?: string;
	readonly code?: string | number | { readonly value: string | number } | null;
}

export type QuickFixMode = "fix" | "explain";

/** How many of the context's diagnostics one action claims, highest severity first. */
export const MAX_CLAIMED_DIAGNOSTICS = 5;

/** Per-diagnostic message budget inside the chat-open query, truncation marker included. */
export const MAX_QUERY_DIAGNOSTIC_TEXT = 200;

/** Per-diagnostic message budget inside the fallback prompt, truncation marker included. */
export const MAX_PROMPT_DIAGNOSTIC_TEXT = 1000;

/** Code-excerpt budget inside the fallback prompt; the overflow marker sits outside the fence. */
export const MAX_PROMPT_EXCERPT_CHARS = 4000;

/**
 * The diagnostics an action claims: whitespace-only messages dropped,
 * severity-ordered (stable within a level), deduplicated by normalized
 * message + range keeping the highest-severity duplicate, and capped at
 * MAX_CLAIMED_DIAGNOSTICS after the dedupe. Generic and identity-preserving
 * so callers keep their own diagnostic objects (phase 2 attaches them to
 * CodeAction.diagnostics), and idempotent so the builders below can re-apply
 * it without changing an already-selected list.
 */
export function selectDiagnostics<T extends QuickFixDiagnostic>(diagnostics: readonly T[]): T[] {
	const ordered = diagnostics
		.filter((diagnostic) => singleLine(diagnostic.message).length > 0)
		.sort((a, b) => a.severity - b.severity);
	const seen = new Set<string>();
	const selected: T[] = [];
	for (const diagnostic of ordered) {
		const key = dedupeKey(diagnostic);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		selected.push(diagnostic);
		if (selected.length === MAX_CLAIMED_DIAGNOSTICS) {
			break;
		}
	}
	return selected;
}

/**
 * The chat-open query: "@litellm /fix <messages>" (or /explain), each message
 * collapsed to one line, defused of chat syntax, and truncated to
 * MAX_QUERY_DIAGNOSTIC_TEXT, joined with "; ". Routes through selectDiagnostics
 * itself, so the query is bounded by construction whatever list the caller
 * passes.
 */
export function buildChatQuery(mode: QuickFixMode, diagnostics: readonly QuickFixDiagnostic[]): string {
	const command = mode === "fix" ? "/fix" : "/explain";
	const summary = selectDiagnostics(diagnostics)
		.map((diagnostic) => truncate(defuseChatSyntax(singleLine(diagnostic.message)), MAX_QUERY_DIAGNOSTIC_TEXT))
		.join("; ");
	return summary.length === 0 ? `@litellm ${command}` : `@litellm ${command} ${summary}`;
}

/**
 * Strip the leading `@` or `#` from a word. Diagnostic messages routinely quote
 * workspace-controlled source text ("Cannot find module './x'"), and this query
 * is SUBMITTED to the chat input rather than shown to the user first, where a
 * `#toolname` token would resolve to a real tool reference on the turn. Only
 * the sigil goes - "#include not found" still reads as "include not found" -
 * which keeps the message meaningful while it can no longer name anything.
 * Deliberately not applied to the fallback prompt: that one is a plain request
 * body with no syntax to hijack.
 */
function defuseChatSyntax(text: string): string {
	return text.replace(/(^|\s)[@#]+(?=[\w-])/g, "$1");
}

export interface FallbackPromptInput {
	/** Which question to ask; the fallback keeps Fix and Explain distinct exactly as the chat path does. */
	readonly mode: QuickFixMode;
	/** Display path of the file the diagnostics belong to (vscode.Uri.path works). */
	readonly path: string;
	readonly languageId: string;
	/** The code around the claimed range; empty omits the excerpt section. */
	readonly excerpt: string;
	readonly diagnostics: readonly QuickFixDiagnostic[];
}

/** What the fallback asks for, per mode; the chat path's two instructions in one non-streaming request. */
function fallbackRequest(mode: QuickFixMode, location: string): string {
	return mode === "fix"
		? `Explain what causes the diagnostics below in ${location} and propose a fix.` +
				" Reply in markdown: describe the cause, then show the corrected code."
		: `Explain the diagnostics below in ${location}.` +
				" Reply in markdown: what they mean, why they are firing on this code, and how they are usually resolved." +
				" Explain rather than rewrite - show code only where it makes the explanation concrete.";
}

/**
 * The model-facing prompt for the fallback path (completeChatOnce into an
 * untitled markdown editor). English by policy. Routes through
 * selectDiagnostics like the query builder, and asks the mode's own question
 * so that picking Explain and getting a rewrite cannot happen just because the
 * chat view was unavailable.
 */
export function buildFallbackPrompt(input: FallbackPromptInput): string {
	const lines = selectDiagnostics(input.diagnostics).map((diagnostic) => `- ${describeDiagnostic(diagnostic)}`);
	const location = input.path.length === 0 ? "the current file" : codeSpan(input.path);
	const sections = [
		fallbackRequest(input.mode, location),
		lines.length === 0 ? "Diagnostics:" : `Diagnostics:\n${lines.join("\n")}`,
	];
	if (input.excerpt.length > 0) {
		sections.push(`Code excerpt:\n${fencedExcerpt(input.excerpt, input.languageId)}`);
	}
	return sections.join("\n\n");
}

function dedupeKey(diagnostic: QuickFixDiagnostic): string {
	const { start, end } = diagnostic.range;
	return `${start.line}:${start.character}:${end.line}:${end.character}:${singleLine(diagnostic.message)}`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Cut to `max` units, marker included, through the shared head-truncation - a
 * cut can land mid-surrogate-pair, and a lone UTF-16 unit is exactly what a
 * gateway rejects. Budgets under the marker's own width lose the marker rather
 * than overrun.
 */
function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return max <= 3 ? truncateKeepingHead(text, max) : `${truncateKeepingHead(text, max - 3)}...`;
}

const SEVERITY_LABELS = ["Error", "Warning", "Information", "Hint"] as const;

/** Origin fields arrive from arbitrary providers; bound them like messages. */
const MAX_ORIGIN_TEXT = 100;

/** One prompt bullet: "Error ts(2304) at line 12: Cannot find name 'x'." */
function describeDiagnostic(diagnostic: QuickFixDiagnostic): string {
	const label = SEVERITY_LABELS[diagnostic.severity] ?? "Diagnostic";
	const origin = describeOrigin(diagnostic);
	const message = truncate(singleLine(diagnostic.message), MAX_PROMPT_DIAGNOSTIC_TEXT);
	return `${label}${origin} at ${describeLines(diagnostic.range)}: ${message}`;
}

/** Editor-style origin: " ts(2304)", " ts", " (2304)", or "" when neither is set. */
function describeOrigin(diagnostic: QuickFixDiagnostic): string {
	const raw = diagnostic.code;
	const code = raw !== null && typeof raw === "object" ? raw.value : raw;
	const source = boundOriginText(diagnostic.source ?? "");
	const codeText = code == null ? "" : boundOriginText(String(code));
	const suffix = codeText.length === 0 ? "" : `(${codeText})`;
	const origin = `${source}${suffix}`;
	return origin.length === 0 ? "" : ` ${origin}`;
}

/** One line, bounded: provider-supplied origin text cannot break the bullet. */
function boundOriginText(text: string): string {
	return truncate(singleLine(text), MAX_ORIGIN_TEXT);
}

/** One-based, editor-style: "line 12" or "lines 3-5". */
function describeLines(range: QuickFixRange): string {
	const start = range.start.line + 1;
	const end = range.end.line + 1;
	return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function longestBacktickRun(text: string): number {
	return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** An inline code span whose delimiter outgrows backticks in the content itself. */
function codeSpan(text: string): string {
	const fence = "`".repeat(longestBacktickRun(text) + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The excerpt inside a fence long enough to survive backtick runs in the kept
 * text, truncated to MAX_PROMPT_EXCERPT_CHARS with the marker outside the
 * fence so the code block stays well-formed. The info string drops backticks
 * and newlines - both invalidate a fence, and real language IDs carry neither.
 *
 * The marker means exactly one thing: the excerpt did not fit. An excerpt
 * inside the budget goes through verbatim, even one ending in an unpaired
 * surrogate - that is the user's own code, and trimming it would both edit
 * what they wrote and claim a truncation that never happened. Lone units are
 * escaped by JSON.stringify on the way to the wire, so nothing malformed
 * leaves here. Cuts still drop a dangling half (truncateKeepingHead), because
 * there the half really is an artifact of ours.
 */
function fencedExcerpt(excerpt: string, languageId: string): string {
	const info = languageId.replace(/[`\r\n]/g, "").trim();
	const kept = truncateKeepingHead(excerpt, MAX_PROMPT_EXCERPT_CHARS);
	const fence = "`".repeat(Math.max(3, longestBacktickRun(kept) + 1));
	const block = `${fence}${info}\n${kept}\n${fence}`;
	return excerpt.length > kept.length ? `${block}\n(excerpt truncated)` : block;
}
