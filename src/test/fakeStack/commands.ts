/**
 * Command dispatch for the fake OpenAI backend: the chat input is the
 * control surface. The last non-empty line of the last user message, when it
 * starts with "%" and names a known verb, selects the response; nothing
 * else in the message does. Bare closing-tag lines are transparent to that
 * rule, because chat hosts wrap the typed request in an envelope (see
 * ENVELOPE_CLOSER). Everything here is deterministic - no clocks, no
 * Math.random - so identical conversations produce identical bytes.
 *
 * Why "%": both obvious sigils are intercepted before the text can reach
 * the model. VS Code Copilot Chat's input claims "/"-prefixed text for its
 * own slash commands (and "@" for participants, "#" for references), so a
 * typed /help rendered as a chip, never reached the model, and the host got
 * plain fallback text back (user-verified against the live UI). Agent CLIs
 * like Claude Code claim a leading "!" to execute shell commands, so "!"
 * fails the same way in a different client. "%" is unclaimed by the tested
 * surfaces (verified against VS Code Copilot Chat and Claude Code; other
 * chat surfaces checked by docs only). A "%" at line start can still occur
 * in rare pasted contexts (templating markers, PostScript DSC lines); that
 * is acceptable - only the LAST non-empty line dispatches, and an unknown
 * verb falls through to the fallback, same as before. One hardening exists
 * for exactly that class: %-comment languages (MATLAB, LaTeX, Erlang, csh
 * transcripts) write "% word" and "% word: args" at line start, so the verb
 * tolerates trailing whitespace only (trimEnd, never trim) - "% error: 429"
 * used to return a real HTTP 429 that looked like a genuine proxy failure;
 * now the whole comment class falls through to the fallback, which itself
 * points at %help.
 *
 * The module is dependency-free (node builtins only): the fake-openai
 * container runs it from a read-only repo mount without node_modules.
 *
 * Emission follows the realism-first principle: proper chunk envelopes
 * (deterministic id, fixed created, model, system_fingerprint,
 * service_tier), word-boundary delta chunking for prose, and a detailed
 * usage trailer gated on stream_options.include_usage. Observed against
 * LiteLLM v1.93: id, system_fingerprint, and service_tier transit VERBATIM
 * and only created is rewritten - assertions still belong on extracted
 * content, never raw bytes.
 *
 * Human-facing diagnostic reports (%help and the introspection verbs) are
 * markdown: chat hosts render replies as markdown, where a single "\n" is a
 * soft break and multi-line plain text collapses into one paragraph. See the
 * "Markdown report formatting" section for the rules. Contract texts stay
 * byte-exact and unformatted: %echo, %play, usage strings, FALLBACK_TEXT,
 * the bad-arguments diagnostic, and the hash-bearing media sentences.
 */

import { createHash } from "node:crypto";
import type { Scenario } from "../scenarios";

export interface CommandContext {
	/** The parsed /v1/chat/completions request body. */
	request: Record<string, unknown>;
	/** Built-in plus runtime-registered scenarios, for %play and %help. */
	scenarios: ReadonlyMap<string, Scenario>;
}

export interface CommandResult {
	scenario: Scenario;
	/** Wait this long before the first response byte (%delay only). */
	firstByteDelayMs?: number;
}

interface CommandInfo {
	verb: string;
	usage: string;
}

interface FakeCommand {
	verb: string;
	usage: string;
	description: string;
	run(arg: string | undefined, context: CommandContext): CommandResult;
}

// ── Caps and fixed texts ─────────────────────────────────────────────────────

const MAX_STREAM_CHUNKS = 500;
const MAX_STREAM_DELAY_MS = 5000;
const MAX_TEXT_WORDS = 5000;
const MAX_THINK_STEPS = 100;
const MAX_DELAY_MS = 60000;
const MAX_SEED = 4294967295;
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
const ERROR_STATUSES = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);

/**
 * The command sigil: the mandatory first byte of a command line. The whole
 * grammar derives from this one constant (recognition, usage strings, help,
 * diagnostics, FALLBACK_TEXT), so swapping the sigil is a one-character edit
 * here plus the prose docs (README, AGENTS.md) and the module comments.
 */
export const COMMAND_SIGIL = "%";

export const FALLBACK_TEXT =
	`This fake model only answers ${COMMAND_SIGIL} commands, so plain text always gets this same fixed reply. ` +
	`Send ${COMMAND_SIGIL}help on its own line to list every command and playback scenario.`;

// ── Message plumbing ─────────────────────────────────────────────────────────

interface WireMessage {
	role?: unknown;
	content?: unknown;
	cache_control?: unknown;
	[key: string]: unknown;
}

function requestMessages(context: CommandContext): WireMessage[] {
	const messages = context.request.messages;
	return Array.isArray(messages) ? (messages as WireMessage[]) : [];
}

/** Concatenated text of a message: string content, or its text parts joined by newlines. */
function messageText(message: WireMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter(
				(part): part is { type: string; text: string } =>
					typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
			)
			.map((part) => part.text)
			.filter((text) => typeof text === "string")
			.join("\n");
	}
	return "";
}

function lastUserIndex(messages: WireMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * A chat host's envelope closer: a line that is EXACTLY an unindented closing
 * tag. Copilot Chat rebuilds the typed request as
 * "<userRequest>\n%help\n</userRequest>", so the message's last line is the
 * closing tag and every interactively typed command would otherwise get the
 * fallback. Such lines are transparent to recognition. An INDENTED closing
 * tag (the usual shape inside pasted XML/HTML) is not transparent. The
 * accepted residue: pasted markup whose ROOT closer ends the message exposes
 * the line above it, which dispatches only if that line is itself an exact
 * command.
 */
const ENVELOPE_CLOSER = /^<\/[A-Za-z][A-Za-z0-9._-]*>$/;

/**
 * The last non-empty, non-envelope-closer line with ONLY its trailing \r
 * stripped - never trimmed, so a leading space disqualifies the line from
 * being a command (the "%" SIGIL must be the line's first byte) and %echo
 * keeps trailing bytes. The verb AFTER the sigil keeps its trailing
 * tolerance only ("%help " and "%stream :50" dispatch) - a space right
 * after the sigil disqualifies, because %-comment languages write "% word"
 * at line start (see the header). Whitespace-only lines count as empty, and
 * bare closing-tag lines are skipped (see ENVELOPE_CLOSER).
 */
function lastNonEmptyLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = (lines[i] ?? "").replace(/\r$/, "");
		if (line.trim() !== "" && !ENVELOPE_CLOSER.test(line)) {
			return line;
		}
	}
	return undefined;
}

// ── Realism-first emission helpers ───────────────────────────────────────────

/** Fixed epoch constant: realistic-looking, never clock-derived. */
const CREATED = 1740000000;
const SYSTEM_FINGERPRINT = "fp_fake_litellm";

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic per-request envelope: the id hashes the CANONICAL FULL
 * request body, so two requests differing in any field (temperature, tools,
 * stream flags) carry different ids while identical requests repeat theirs.
 */
/** One canonicalJson + sha256 per request, not per chunk: large attachment bodies would otherwise hash quadratically. */
const envelopeCache = new WeakMap<object, Record<string, unknown>>();

function envelope(context: CommandContext): Record<string, unknown> {
	const cached = envelopeCache.get(context.request);
	if (cached !== undefined) {
		return cached;
	}
	const value = {
		id: `chatcmpl-fake-${sha256Hex(canonicalJson(context.request)).slice(0, 24)}`,
		object: "chat.completion.chunk",
		created: CREATED,
		model: typeof context.request.model === "string" ? context.request.model : "fake",
		system_fingerprint: SYSTEM_FINGERPRINT,
		service_tier: "default",
	};
	envelopeCache.set(context.request, value);
	return value;
}

function chunkOf(context: CommandContext, delta: Record<string, unknown>, finishReason?: string): unknown {
	return {
		...envelope(context),
		choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
	};
}

/** Real OpenAI semantics: the streaming usage trailer is sent only when stream_options.include_usage asks for it. */
function wantsUsage(context: CommandContext): boolean {
	const options = context.request.stream_options;
	return (
		typeof options === "object" && options !== null && (options as { include_usage?: unknown }).include_usage === true
	);
}

/** Zero or one trailer chunks, per the include_usage gate. */
function usageTrailerChunks(context: CommandContext, outputChars: number, reasoningChars = 0): unknown[] {
	return wantsUsage(context) ? [usageTrailer(context, outputChars, reasoningChars)] : [];
}

function usageTrailer(context: CommandContext, outputChars: number, reasoningChars = 0): unknown {
	const promptChars = JSON.stringify(context.request.messages ?? []).length;
	return {
		...envelope(context),
		choices: [],
		usage: {
			prompt_tokens: Math.ceil(promptChars / 4),
			completion_tokens: Math.ceil((outputChars + reasoningChars) / 4),
			total_tokens: Math.ceil(promptChars / 4) + Math.ceil((outputChars + reasoningChars) / 4),
			prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: Math.ceil(reasoningChars / 4), audio_tokens: 0 },
		},
	};
}

/**
 * Deterministic word-boundary chunking: pieces keep their trailing
 * whitespace, grouped in a fixed size cycle. Content too short to cut yields
 * a single delta; the chunker never refuses to cut cuttable text.
 */
function chunkText(text: string): string[] {
	const pieces = text.split(/(?<=\s)/).filter((piece) => piece !== "");
	// The cycle starts at 1 so two cuttable pieces always yield two deltas.
	const sizes = [1, 2, 3, 2, 4];
	const chunks: string[] = [];
	let i = 0;
	let cycle = 0;
	while (i < pieces.length) {
		const take = sizes[cycle % sizes.length] as number;
		chunks.push(pieces.slice(i, i + take).join(""));
		i += take;
		cycle++;
	}
	return chunks.length > 0 ? chunks : [""];
}

/** A streamed prose reply: role on the first delta, chunked content, finish, usage trailer. */
function textResult(context: CommandContext, text: string, finishReason = "stop"): CommandResult {
	const parts = chunkText(text);
	const chunks = parts.map((part, index) =>
		chunkOf(context, index === 0 ? { role: "assistant", content: part } : { content: part })
	);
	chunks.push(chunkOf(context, {}, finishReason));
	chunks.push(...usageTrailerChunks(context, text.length));
	return { scenario: { type: "sse", chunks } };
}

/** A recognized verb with bad arguments always gets this fixed diagnostic reply, never an HTTP error. */
function diagnostic(context: CommandContext, command: CommandInfo): CommandResult {
	return textResult(
		context,
		`Bad arguments for ${COMMAND_SIGIL}${command.verb}. Usage: ${command.usage}. Send ${COMMAND_SIGIL}help on its own line for the full command list.`
	);
}

// ── Markdown report formatting ───────────────────────────────────────────────
//
// Diagnostic reports emit one "- " bullet per fact and blank lines between
// logical sections, with every VARIABLE value (tool names, mime types, roles,
// JSON fragments) inside a backtick code span. The span is dual-purpose:
// bullets survive markdown rendering, and content-derived text cannot style
// the report (a tool description containing "*" or "_" stays literal).
// Single-sentence replies ("no tools offered", the zero-marker sentence) stay
// bare - one sentence renders fine and their bytes are pinned by the suites.

/**
 * A code span around one variable value. Newlines collapse to single spaces
 * first: a code span cannot contain a line ending, so a value carrying
 * "\n\n# heading" would otherwise break the bullet, leave the span
 * unclosed, and inject real markdown structure. A value containing
 * backticks gets a longer span fence padded with spaces - CommonMark's own
 * escape for backticks inside code spans - so no value can close the span
 * early. An empty value renders as the fixed `(empty)` token: a bare "``"
 * is not a code span. Renderers strip one leading and one trailing space
 * per span (that is what closes over the pad); purely cosmetic for values
 * with edge spaces, and record lines never start with one.
 */
function code(value: string): string {
	const flat = value.replace(/\r\n?|\n/g, " ");
	if (flat === "") {
		return "`(empty)`";
	}
	const runs = flat.match(/`+/g);
	if (runs === null) {
		return `\`${flat}\``;
	}
	const fence = "`".repeat(Math.max(...runs.map((run) => run.length)) + 1);
	return `${fence} ${flat} ${fence}`;
}

/** One report bullet. */
function bullet(fact: string): string {
	return `- ${fact}`;
}

/**
 * Structured record lines (part shapes, marker positions, hash lines) render
 * as bullets holding ONE code span each: the record's bytes stay grep- and
 * regex-extractable exactly as before (sha256 tokens stay bare hex), and no
 * fragment of the record can style the report.
 */
function recordBullets(records: string[]): string[] {
	return records.map((record) => bullet(code(record)));
}

/** Report sections joined by blank lines - the markdown paragraph/list boundary. */
function sections(...blocks: string[][]): string {
	return blocks.map((lines) => lines.join("\n")).join("\n\n");
}

// ── Argument parsing ─────────────────────────────────────────────────────────

/** Counts are positive integers within their cap; anything else is undefined. */
function parseCount(text: string, max: number): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const value = Number(trimmed);
	return value >= 1 && value <= max ? value : undefined;
}

/** The %text seed is 0-based: 0..4294967295, the mulberry32 state domain. */
function parseSeed(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const value = Number(trimmed);
	return value <= MAX_SEED ? value : undefined;
}

/**
 * The %echon escape decoder: exactly two escapes, "\n" to a newline and
 * "\\" to a literal backslash, scanned left to right so "\\n" stays a
 * literal backslash-n. Every other byte passes through untouched. %echo
 * stays the byte-exact oracle; this verb exists precisely so that contract
 * never gains interpretation.
 */
function decodeEchonEscapes(text: string): string {
	return text.replace(/\\(n|\\)/g, (_, escaped: string) => (escaped === "n" ? "\n" : "\\"));
}

// ── Deterministic prose generation (%text) ───────────────────────────────────

/** Same PRNG family the fuzz suites use; seed 0 is valid state. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PROSE_WORDS = [
	"signal",
	"harbor",
	"granite",
	"lantern",
	"meadow",
	"copper",
	"drift",
	"ember",
	"quiet",
	"orbit",
	"thread",
	"canyon",
	"velvet",
	"morning",
	"ledger",
	"current",
	"basalt",
	"harvest",
	"mirror",
	"stride",
	"willow",
	"beacon",
	"summit",
	"river",
	"cinder",
	"pattern",
	"hollow",
	"amber",
	"circuit",
	"garden",
];

function generateProse(wordCount: number, seed: number): string {
	const random = mulberry32(seed);
	const words: string[] = [];
	let sentenceLength = 0;
	let sentenceTarget = 6 + Math.floor(random() * 7);
	for (let i = 0; i < wordCount; i++) {
		let word = PROSE_WORDS[Math.floor(random() * PROSE_WORDS.length)] as string;
		if (sentenceLength === 0) {
			word = word.charAt(0).toUpperCase() + word.slice(1);
		}
		sentenceLength++;
		const last = i === wordCount - 1;
		if (sentenceLength >= sentenceTarget || last) {
			words.push(`${word}.`);
			sentenceLength = 0;
			sentenceTarget = 6 + Math.floor(random() * 7);
		} else {
			words.push(word);
		}
	}
	return words.join(" ");
}

/** Default %text seed: hashed from the input conversation, so same conversation, same bytes. */
function seedFromInput(context: CommandContext): number {
	const digest = createHash("sha256")
		.update(JSON.stringify(context.request.messages ?? []))
		.digest();
	return digest.readUInt32BE(0);
}

// ── Wire-part forensics (%messages, %cache, %attachments) ───────────────────

/** JSON with object keys sorted lexicographically at every depth; arrays keep order. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

interface DataUrlPayload {
	mime: string;
	bytes: Uint8Array;
}

function decodeDataUrl(url: string): DataUrlPayload | undefined {
	const match = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
	if (!match) {
		return undefined;
	}
	const [, mime, base64, payload] = match;
	try {
		if (base64) {
			return { mime: mime as string, bytes: Buffer.from(payload as string, "base64") };
		}
		return { mime: mime as string, bytes: Buffer.from(decodeURIComponent(payload as string), "utf8") };
	} catch {
		// A malformed percent-escape or base64 payload must never escape the
		// dispatcher as a thrown error; the caller hashes the raw URL instead.
		return undefined;
	}
}

interface WirePart {
	kind: string;
	mime: string;
	bytes: Uint8Array;
}

/** Classify one wire-level content part into its honest, hashable surface. */
function classifyPart(part: unknown): WirePart {
	if (typeof part === "object" && part !== null) {
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			return { kind: "text", mime: "-", bytes: Buffer.from(record.text, "utf8") };
		}
		if (record.type === "image_url") {
			const url = (record.image_url as { url?: unknown } | undefined)?.url;
			if (typeof url === "string") {
				const decoded = decodeDataUrl(url);
				if (decoded) {
					return { kind: "image_url", mime: decoded.mime, bytes: decoded.bytes };
				}
				return { kind: "image_url", mime: "-", bytes: Buffer.from(url, "utf8") };
			}
		}
		if (record.type === "file") {
			const fileData = (record.file as { file_data?: unknown } | undefined)?.file_data;
			if (typeof fileData === "string") {
				const decoded = decodeDataUrl(fileData);
				if (decoded) {
					return { kind: "file", mime: decoded.mime, bytes: decoded.bytes };
				}
				return { kind: "file", mime: "-", bytes: Buffer.from(fileData, "utf8") };
			}
		}
	}
	return { kind: "unknown", mime: "-", bytes: Buffer.from(canonicalJson(part), "utf8") };
}

/** One record line per wire part; empty when no message carries content. */
function attachmentRecords(context: CommandContext): string[] {
	const lines: string[] = [];
	requestMessages(context).forEach((message, messageIndex) => {
		const role = typeof message.role === "string" ? message.role : "unknown";
		const describe = (partIndex: number, part: WirePart): void => {
			lines.push(
				`message[${messageIndex}] ${role} part[${partIndex}]: kind=${part.kind} mime=${part.mime} ` +
					`bytes=${part.bytes.length} sha256=${sha256Hex(part.bytes)}`
			);
		};
		if (typeof message.content === "string") {
			const kind = role === "tool" ? "tool-result" : "text";
			describe(0, { kind, mime: "-", bytes: Buffer.from(message.content, "utf8") });
		} else if (Array.isArray(message.content)) {
			message.content.forEach((part, partIndex) => {
				const classified = classifyPart(part);
				describe(partIndex, role === "tool" ? { ...classified, kind: "tool-result" } : classified);
			});
		} else if (message.content !== undefined && message.content !== null) {
			describe(0, { kind: "unknown", mime: "-", bytes: Buffer.from(canonicalJson(message.content), "utf8") });
		}
	});
	return lines;
}

function partShape(part: unknown): string {
	if (typeof part === "object" && part !== null) {
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			return `text(${record.text.length})`;
		}
		if (typeof record.type === "string") {
			return record.type;
		}
	}
	return "unknown";
}

/** One record line per cache_control marker position; empty when none arrived. */
function cacheMarkerRecords(context: CommandContext): string[] {
	const lines: string[] = [];
	const tools = Array.isArray(context.request.tools) ? context.request.tools : [];
	tools.forEach((tool, index) => {
		if (typeof tool === "object" && tool !== null && (tool as Record<string, unknown>).cache_control !== undefined) {
			lines.push(`tools[${index}]: cache_control`);
		}
	});
	requestMessages(context).forEach((message, messageIndex) => {
		if (message.cache_control !== undefined) {
			lines.push(`messages[${messageIndex}]: cache_control`);
		}
		if (Array.isArray(message.content)) {
			message.content.forEach((part, partIndex) => {
				if (
					typeof part === "object" &&
					part !== null &&
					(part as Record<string, unknown>).cache_control !== undefined
				) {
					lines.push(`messages[${messageIndex}].content[${partIndex}]: cache_control`);
				}
			});
		}
	});
	return lines;
}

// ── Generated media payloads (%image, %audio) ────────────────────────────────

// Observed against the live stack (LiteLLM v1.93): both media delta shapes
// below - the delta.images list with a data URL, and the gpt-4o-style
// delta.audio object - transit the proxy VERBATIM, full base64 payload
// intact. The extension surfaces both as vscode.LanguageModelDataPart, so
// LM-level tests assert DataPart byte fidelity against the pinned hashes
// while raw SSE observation keeps pinning proxy transit itself.

/** 1x1 red PNG, byte-stable. */
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64"
);

/** Minimal 8-bit mono WAV (44-byte header + 8 samples of silence), byte-stable. */
const WAV_BYTES = Buffer.from("UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==", "base64");

/** Pinned sha256 of PNG_BYTES; suites import this instead of re-deriving it. */
export const PNG_SHA256 = "57c5b0ba802ba3aa9c4ebd11a8ef32d173abc6dd5b3deabb7cd540b66e14edc5";

/** Pinned sha256 of WAV_BYTES; suites import this instead of re-deriving it. */
export const WAV_SHA256 = "08662970568d4e2cf49988067bee006f7e8ded8c4cd93f4aa6ef4211b891d8af";

// ── Tool-call flow (%tool) ───────────────────────────────────────────────────

interface OfferedTool {
	name: string;
	description: string;
}

function offeredTools(context: CommandContext): OfferedTool[] {
	const tools = Array.isArray(context.request.tools) ? context.request.tools : [];
	const offered: OfferedTool[] = [];
	for (const tool of tools) {
		if (typeof tool !== "object" || tool === null) {
			continue;
		}
		const fn = (tool as { function?: { name?: unknown; description?: unknown } }).function;
		if (typeof fn?.name === "string") {
			offered.push({ name: fn.name, description: typeof fn.description === "string" ? fn.description : "" });
		}
	}
	return offered;
}

function runTool(arg: string | undefined, context: CommandContext, command: CommandInfo): CommandResult {
	const trimmed = arg?.trim();
	if (!trimmed) {
		return diagnostic(context, command);
	}
	const space = trimmed.search(/\s/);
	const name = space === -1 ? trimmed : trimmed.slice(0, space);
	const rawArgs = space === -1 ? "{}" : trimmed.slice(space).trim();
	if (Buffer.byteLength(rawArgs, "utf8") > MAX_TOOL_ARGS_BYTES) {
		return diagnostic(context, command);
	}
	let parsedArgs: unknown;
	try {
		parsedArgs = JSON.parse(rawArgs);
	} catch {
		return textResult(
			context,
			`The arguments for ${COMMAND_SIGIL}tool:${name} are not valid JSON. Usage: ${command.usage}. Send ${COMMAND_SIGIL}help for the full command list.`
		);
	}
	if (!offeredTools(context).some((tool) => tool.name === name)) {
		return textResult(
			context,
			`The tool "${name}" is not offered by this request. Send ${COMMAND_SIGIL}tools on its own line to list what the host offered.`
		);
	}

	const messages = requestMessages(context);
	const userIndex = lastUserIndex(messages);
	const toolResults = messages.filter((message, index) => index > userIndex && message.role === "tool");
	const lastResult = toolResults[toolResults.length - 1];
	if (lastResult !== undefined) {
		return textResult(context, `tool ${name} returned: ${messageText(lastResult)}`);
	}

	const priorToolTurns = messages.filter((message) => message.role === "tool").length;
	const callId = `call_fake_${priorToolTurns}`;
	const argText = JSON.stringify(parsedArgs);
	const chunks = [
		chunkOf(context, {
			role: "assistant",
			tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: argText } }],
		}),
		chunkOf(context, {}, "tool_calls"),
		...usageTrailerChunks(context, argText.length),
	];
	return { scenario: { type: "sse", chunks } };
}

// ── The dispatch table ───────────────────────────────────────────────────────

function bare(run: (context: CommandContext) => CommandResult) {
	return (arg: string | undefined, context: CommandContext, command: CommandInfo): CommandResult =>
		arg === undefined ? run(context) : diagnostic(context, command);
}

const COMMAND_TABLE: ReadonlyArray<{
	verb: string;
	usage: string;
	description: string;
	run(arg: string | undefined, context: CommandContext, command: CommandInfo): CommandResult;
}> = [
	{
		verb: "help",
		usage: `${COMMAND_SIGIL}help`,
		description: `list every command and the available ${COMMAND_SIGIL}play scenarios`,
		run: bare((context) => {
			const commandBullets = COMMANDS.map((command) => bullet(`${code(command.usage)} - ${command.description}`));
			const playTargets = Array.from(context.scenarios.keys()).sort().map(code).join(", ");
			return textResult(context, sections(["Commands:"], commandBullets, [`Play targets: ${playTargets}`]));
		}),
	},
	{
		verb: "params",
		usage: `${COMMAND_SIGIL}params`,
		description: "echo the request's generation parameters (fixed allowlist)",
		run: bare((context) => {
			const allowlist = [
				"frequency_penalty",
				"logprobs",
				"max_completion_tokens",
				"max_tokens",
				"model",
				"n",
				"parallel_tool_calls",
				"presence_penalty",
				"reasoning_effort",
				"response_format",
				"seed",
				"stop",
				"stream",
				"stream_options",
				"temperature",
				"tool_choice",
				"top_logprobs",
				"top_p",
				"verbosity",
			];
			const lines = allowlist
				.filter((key) => context.request[key] !== undefined)
				.map((key) => bullet(`${key}: ${code(JSON.stringify(context.request[key]))}`));
			return textResult(context, lines.length > 0 ? lines.join("\n") : "no generation parameters received");
		}),
	},
	{
		verb: "tools",
		usage: `${COMMAND_SIGIL}tools`,
		description: "list the tools the host offered, with descriptions",
		run: bare((context) => {
			const offered = offeredTools(context);
			if (offered.length === 0) {
				return textResult(context, "no tools offered");
			}
			// Empty names and empty descriptions both take code()'s `(empty)`
			// rendering - one rule, no special-cased bullet shapes.
			const lines = offered.map((tool) => bullet(`${code(tool.name)}: ${code(tool.description)}`));
			return textResult(context, lines.join("\n"));
		}),
	},
	{
		verb: "messages",
		usage: `${COMMAND_SIGIL}messages`,
		description: "per message: index, role, and content part shapes (never content)",
		run: bare((context) => {
			const records = requestMessages(context).map((message, index) => {
				const role = typeof message.role === "string" ? message.role : "unknown";
				const shape =
					typeof message.content === "string"
						? `text(${message.content.length})`
						: Array.isArray(message.content)
							? message.content.map(partShape).join(", ")
							: "empty";
				return `message[${index}] ${role}: ${shape}`;
			});
			return textResult(context, records.length > 0 ? recordBullets(records).join("\n") : "no messages received");
		}),
	},
	{
		verb: "cache",
		usage: `${COMMAND_SIGIL}cache`,
		description: "report cache_control marker positions and count",
		run: bare((context) => {
			const markers = cacheMarkerRecords(context);
			if (markers.length === 0) {
				return textResult(context, "no cache_control markers received (none sent, or stripped by the proxy)");
			}
			// The total is a closing PARAGRAPH, not a bullet: a bullet after the
			// blank line would turn the whole marker list loose in CommonMark,
			// spacing every bullet as its own paragraph.
			return textResult(context, sections(recordBullets(markers), [`total: ${markers.length}`]));
		}),
	},
	{
		verb: "deployment",
		usage: `${COMMAND_SIGIL}deployment`,
		description: "report which upstream deployment served this request",
		run: bare((context) =>
			textResult(
				context,
				bullet(`deployment: ${code(typeof context.request.model === "string" ? context.request.model : "unknown")}`)
			)
		),
	},
	{
		verb: "attachments",
		usage: `${COMMAND_SIGIL}attachments`,
		description: "per WIRE part: kind, mime, byte length, sha256 of decoded payload (post-conversion, never content)",
		run: bare((context) => {
			const records = attachmentRecords(context);
			return textResult(context, records.length > 0 ? recordBullets(records).join("\n") : "no message parts received");
		}),
	},
	{
		verb: "image",
		usage: `${COMMAND_SIGIL}image`,
		description: "emit a byte-stable tiny PNG plus text carrying its sha256",
		run: bare((context) => {
			const text = `Generated a PNG image, ${PNG_BYTES.length} bytes, sha256=${sha256Hex(PNG_BYTES)}.`;
			const chunks = [
				chunkOf(context, {
					role: "assistant",
					images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` } }],
				}),
				...chunkText(text).map((part) => chunkOf(context, { content: part })),
				chunkOf(context, {}, "stop"),
				...usageTrailerChunks(context, text.length),
			];
			return { scenario: { type: "sse", chunks } };
		}),
	},
	{
		verb: "audio",
		usage: `${COMMAND_SIGIL}audio`,
		description: "emit a byte-stable tiny WAV plus text carrying its sha256",
		run: bare((context) => {
			const text = `Generated a WAV clip, ${WAV_BYTES.length} bytes, sha256=${sha256Hex(WAV_BYTES)}.`;
			const chunks = [
				chunkOf(context, {
					role: "assistant",
					audio: { id: "audio_fake_1", data: WAV_BYTES.toString("base64"), transcript: "fake audio clip" },
				}),
				...chunkText(text).map((part) => chunkOf(context, { content: part })),
				chunkOf(context, {}, "stop"),
				...usageTrailerChunks(context, text.length),
			];
			return { scenario: { type: "sse", chunks } };
		}),
	},
	{
		verb: "tool",
		usage: `${COMMAND_SIGIL}tool:<name> [json]`,
		// Angle-bracket tokens in descriptions are backticked: a bare <name>
		// renders unreliably across markdown renderers (HTML-allowing ones
		// swallow it as a tag).
		description: "call the offered tool `<name>` with the JSON args; with a tool result present, summarize it",
		run: runTool,
	},
	{
		verb: "play",
		usage: `${COMMAND_SIGIL}play:<scenario>`,
		description: "play a built-in or runtime-registered scenario verbatim",
		run(arg, context, command) {
			const name = arg?.trim();
			if (!name) {
				return diagnostic(context, command);
			}
			const scenario = context.scenarios.get(name);
			if (!scenario) {
				return textResult(
					context,
					`Unknown scenario "${name}". Send ${COMMAND_SIGIL}help on its own line to list the available play targets.`
				);
			}
			return { scenario };
		},
	},
	{
		verb: "stream",
		usage: `${COMMAND_SIGIL}stream:<n>[:<delay-ms>]`,
		description: `stream n fixed chunks with a per-chunk delay (default 100ms; n <= ${MAX_STREAM_CHUNKS}, delay <= ${MAX_STREAM_DELAY_MS})`,
		run(arg, context, command) {
			const pieces = (arg ?? "").split(":");
			if (arg === undefined || pieces.length > 2) {
				return diagnostic(context, command);
			}
			const count = parseCount(pieces[0] ?? "", MAX_STREAM_CHUNKS);
			const delayMs = pieces.length === 2 ? parseCount(pieces[1] ?? "", MAX_STREAM_DELAY_MS) : 100;
			if (count === undefined || delayMs === undefined) {
				return diagnostic(context, command);
			}
			const contentChars = Array.from({ length: count }, (_, i) => `chunk${i + 1} `.length).reduce((a, b) => a + b, 0);
			const chunks = [
				...Array.from({ length: count }, (_, i) =>
					chunkOf(context, i === 0 ? { role: "assistant", content: "chunk1 " } : { content: `chunk${i + 1} ` })
				),
				chunkOf(context, {}, "stop"),
				...usageTrailerChunks(context, contentChars),
			];
			return { scenario: { type: "sse-delayed", delayMs, chunks } };
		},
	},
	{
		verb: "error",
		usage: `${COMMAND_SIGIL}error:<status>`,
		description: "fail with that HTTP status (400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504)",
		run(arg, context, command) {
			const trimmed = arg?.trim() ?? "";
			const status = /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
			if (status === undefined || !ERROR_STATUSES.has(status)) {
				return diagnostic(context, command);
			}
			return {
				scenario: {
					type: "error",
					statusCode: status,
					body: { error: { message: `fake error with status ${status}`, type: "fake_error", code: String(status) } },
				},
			};
		},
	},
	{
		verb: "text",
		usage: `${COMMAND_SIGIL}text:<n>[:<seed>]`,
		description: `a deterministic n-word paragraph (n <= ${MAX_TEXT_WORDS}); the optional seed is 0-based`,
		run(arg, context, command) {
			const pieces = (arg ?? "").split(":");
			if (arg === undefined || pieces.length > 2) {
				return diagnostic(context, command);
			}
			const count = parseCount(pieces[0] ?? "", MAX_TEXT_WORDS);
			const seed = pieces.length === 2 ? parseSeed(pieces[1] ?? "") : seedFromInput(context);
			if (count === undefined || seed === undefined) {
				return diagnostic(context, command);
			}
			return textResult(context, generateProse(count, seed));
		},
	},
	{
		verb: "think",
		usage: `${COMMAND_SIGIL}think:<n>`,
		description: `n reasoning chunks then a closing text (n <= ${MAX_THINK_STEPS})`,
		run(arg, context, command) {
			const count = arg === undefined ? undefined : parseCount(arg, MAX_THINK_STEPS);
			if (count === undefined) {
				return diagnostic(context, command);
			}
			const closing = `Finished thinking in ${count} steps.`;
			const reasoning = Array.from({ length: count }, (_, i) => `Thinking step ${i + 1} of ${count}. `);
			const chunks = [
				...reasoning.map((step, i) =>
					chunkOf(context, i === 0 ? { role: "assistant", reasoning_content: step } : { reasoning_content: step })
				),
				chunkOf(context, { content: closing }),
				chunkOf(context, {}, "stop"),
				...usageTrailerChunks(context, closing.length, reasoning.join("").length),
			];
			return { scenario: { type: "sse", chunks } };
		},
	},
	{
		verb: "echo",
		usage: `${COMMAND_SIGIL}echo:<text>`,
		description: "reply with exactly `<text>` (case preserved, line-bounded)",
		run(arg, context, command) {
			if (arg === undefined || arg === "") {
				return diagnostic(context, command);
			}
			return textResult(context, arg);
		},
	},
	{
		verb: "echon",
		usage: `${COMMAND_SIGIL}echon:<text>`,
		description:
			"reply with `<text>` decoding `\\n` into newlines and `\\\\` into a backslash (multi-line replies from one line)",
		run(arg, context, command) {
			if (arg === undefined || arg === "") {
				return diagnostic(context, command);
			}
			return textResult(context, decodeEchonEscapes(arg));
		},
	},
	{
		verb: "finish",
		usage: `${COMMAND_SIGIL}finish:<reason>`,
		description: "fixed partial text ending with finish_reason length or content_filter",
		run(arg, context, command) {
			const reason = arg?.trim();
			if (reason !== "length" && reason !== "content_filter") {
				return diagnostic(context, command);
			}
			return textResult(context, "This reply stops early on purpose", reason);
		},
	},
	{
		verb: "delay",
		usage: `${COMMAND_SIGIL}delay:<ms>`,
		description: `wait that long before the first byte, then a short text (ms <= ${MAX_DELAY_MS})`,
		run(arg, context, command) {
			const delayMs = arg === undefined ? undefined : parseCount(arg, MAX_DELAY_MS);
			if (delayMs === undefined) {
				return diagnostic(context, command);
			}
			const result = textResult(context, `Replied after a ${delayMs}ms first-byte delay.`);
			return { ...result, firstByteDelayMs: delayMs };
		},
	},
];

/** The dispatch table, exported so %help, the docker tests, and the suites read one source of truth. */
export const COMMANDS: ReadonlyArray<FakeCommand> = COMMAND_TABLE.map((entry) => ({
	verb: entry.verb,
	usage: entry.usage,
	description: entry.description,
	run: (arg, context) => entry.run(arg, context, entry),
}));

const COMMANDS_BY_VERB = new Map(COMMANDS.map((command) => [command.verb, command]));

// ── Recognition and dispatch ─────────────────────────────────────────────────

interface ParsedCommand {
	command: FakeCommand;
	arg: string | undefined;
}

/**
 * The exact line recognition reads (last non-empty, non-envelope-closer line
 * of the last user message), exposed for the fake server's request log: a
 * command that fails to dispatch is diagnosable from the log alone, because
 * leading whitespace, host-appended context, and typos are all visible in
 * that line. parseCommand consumes this, so log and dispatch cannot disagree.
 */
export function dispatchLine(context: CommandContext): string | undefined {
	const messages = requestMessages(context);
	const lastUser = messages[lastUserIndex(messages)];
	return lastUser === undefined ? undefined : lastNonEmptyLine(messageText(lastUser));
}

/**
 * A command is recognized ONLY on the last non-empty line of the last user
 * message (bare closing-tag lines are transparent; see ENVELOPE_CLOSER),
 * with a mandatory leading "%". The verb (between the sigil and
 * the first colon, or end of line) matches case-insensitively and tolerates
 * trailing whitespace ONLY - trimEnd, never trim, so "%help " and
 * "%stream :50" dispatch while "% help" is plain text (see the module
 * header for the %-comment rationale). The argument is everything after the
 * first colon, case preserved (%echo is byte-exact after that colon;
 * numeric commands trim their pieces themselves). Lines starting with "/"
 * or "!" are ordinary text - chat surfaces intercept both before they can
 * reach the model, so they must never dispatch here either.
 */
function parseCommand(context: CommandContext): ParsedCommand | undefined {
	const line = dispatchLine(context);
	if (line === undefined || !line.startsWith(COMMAND_SIGIL)) {
		return undefined;
	}
	const body = line.slice(COMMAND_SIGIL.length);
	const colon = body.indexOf(":");
	const verb = (colon === -1 ? body : body.slice(0, colon)).trimEnd().toLowerCase();
	const command = COMMANDS_BY_VERB.get(verb);
	if (command === undefined) {
		return undefined;
	}
	return { command, arg: colon === -1 ? undefined : body.slice(colon + 1) };
}

/** Arm 1 of the server's dispatch order: undefined means "no command here", fall through. */
export function dispatchCommand(context: CommandContext): CommandResult | undefined {
	const parsed = parseCommand(context);
	if (parsed === undefined) {
		return undefined;
	}
	return parsed.command.run(parsed.arg, context);
}

/** The final dispatch arm: the fixed reply for input that matched nothing. */
export function fallbackReply(context: CommandContext): CommandResult {
	return textResult(context, FALLBACK_TEXT);
}
