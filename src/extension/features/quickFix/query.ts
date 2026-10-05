/**
 * Pure query core for the quick-fix feature: which diagnostics an action claims, the chat query the action opens, and
 * the model-facing fallback prompt (English by policy) when the chat surface is unavailable. Structural shapes only -
 * no vscode import - so the bun tree pins every behavior.
 */

import { PARTICIPANT_NAME } from "../../../shared/config/commandIds";
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
 * Structural subset of vscode.Diagnostic: severity follows the host's DiagnosticSeverity numbering (0 Error, 1 Warning,
 * 2 Information, 3 Hint), and `code` admits the host's `{ value, target }` object form plus the null that third-party
 * providers ship despite the host typing.
 */
export interface QuickFixDiagnostic {
	readonly message: string;
	readonly range: QuickFixRange;
	readonly severity: number;
	readonly source?: string;
	readonly code?: string | number | { readonly value: string | number } | null;
}

export type QuickFixMode = "fix" | "explain";

export const MAX_CLAIMED_DIAGNOSTICS = 5;

export const MAX_QUERY_DIAGNOSTIC_TEXT = 200;

export const MAX_PROMPT_DIAGNOSTIC_TEXT = 1000;

export const MAX_PROMPT_EXCERPT_CHARS = 4000;

/**
 *   Generic and identity-preserving -> callers keep their own diagnostic objects
 *   idempotent                      -> the builders below can re-apply it without changing an already-selected list
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

/** Routes through selectDiagnostics itself, so the query is bounded by construction whatever list the caller passes. */
export function buildChatQuery(mode: QuickFixMode, diagnostics: readonly QuickFixDiagnostic[]): string {
	const command = mode === "fix" ? "/fix" : "/explain";
	const summary = selectDiagnostics(diagnostics)
		.map((diagnostic) => truncate(defuseChatSyntax(singleLine(diagnostic.message)), MAX_QUERY_DIAGNOSTIC_TEXT))
		.join("; ");
	const participant = `@${PARTICIPANT_NAME}`;
	return summary.length === 0 ? `${participant} ${command}` : `${participant} ${command} ${summary}`;
}

/**
 * Diagnostic messages routinely quote workspace-controlled source text ("Cannot find module './x'"), and this query is
 * SUBMITTED to the chat input rather than shown to the user first, where a `#toolname` token would resolve to a real
 * tool reference on the turn. Only the sigil goes - "#include not found" still reads as "include not found" - which
 * keeps the message meaningful while it can no longer name anything.
 *
 *   that one is a plain request body with no syntax to hijack -> Deliberately not applied to the fallback prompt
 */
function defuseChatSyntax(text: string): string {
	return text.replace(/(^|\s)[@#]+(?=[\w-])/g, "$1");
}

export interface FallbackPromptInput {
	readonly mode: QuickFixMode;
	readonly path: string;
	readonly languageId: string;
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
 * English by policy. Routes through selectDiagnostics like the query builder, and asks the mode's own question so that
 * picking Explain and getting a rewrite cannot happen just because the chat view was unavailable.
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
 * Cut to `max` units, marker included, through the shared head-truncation - a cut can land mid-surrogate-pair, and a
 * lone UTF-16 unit is exactly what a gateway rejects. Budgets under the marker's own width lose the marker rather than
 * overrun.
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

function codeSpan(text: string): string {
	const fence = "`".repeat(longestBacktickRun(text) + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The excerpt is the user's own code, so within budget it goes through verbatim even when it ends in an unpaired
 * surrogate, since trimming it would claim a truncation that never happened and JSON.stringify escapes lone
 * units on the way to the wire.
 *
 *   there the half is our artifact                                -> the dangling half dropped
 *   backtick or newline in the language ID                        -> dropped
 *   both invalidate a fence and no real language ID carries either -> dropped
 */
function fencedExcerpt(excerpt: string, languageId: string): string {
	const info = languageId.replace(/[`\r\n]/g, "").trim();
	const kept = truncateKeepingHead(excerpt, MAX_PROMPT_EXCERPT_CHARS);
	const fence = "`".repeat(Math.max(3, longestBacktickRun(kept) + 1));
	const block = `${fence}${info}\n${kept}\n${fence}`;
	return excerpt.length > kept.length ? `${block}\n(excerpt truncated)` : block;
}
