/**
 * What the agent tools hand back, in model-facing English, and what the confirmation cards say to the user, localized
 * at call time. Dashboard state carries secret LOCATIONS by construction; every string the model or the user reads
 * leaves through modelFacing(), the one function over the shared KnownSecrets matcher: wiring.ts applies it at the
 * tool's exits, this file per string and identifier while each is whole.
 */

import * as l10n from "@vscode/l10n";
import type { DashboardState } from "../../../dashboard/viewModels";
import type { DashboardSubmission } from "../../../extension/dashboard/panel";
import { isCredentialHeader } from "../../../shared/serverEntry";
import type { ServerStatus } from "../../../shared/servers";
import { displayUrl } from "../../../shared/util/displayUrl";
import { isRecord } from "../../../shared/util/json";
import { KnownSecrets } from "../../../shared/util/knownSecrets";
import type { DiagnosticsSnapshot } from "../../ui/issueReporter";
import { type ConfigurationSection, CREDENTIAL_HEADER_PLACEHOLDER } from "./inputSchema";
import type { AgentRequest, RefusalReason, SecretPrompt } from "./planner";

/**
 * The reply bound, in UTF-16 code units, fixed in code like the consult tool's outgoing bound: a configuration with
 * hundreds of models must not flood the agent's context. The cut is marked so the agent knows to ask for a section.
 */
const AGENT_RESULT_CHAR_LIMIT = 60_000;

declare const MODEL_FACING: unique symbol;

/** Text that left through modelFacing(); the wiring's result and prepared-invocation constructors take nothing else. */
export type ModelFacing = string & { readonly [MODEL_FACING]: true };

/**
 * Where a credential placeholder belongs: a node in a value tree (scrubSecrets) or a part of a card
 * (describeServerChange), rendered as the placeholder by modelFacing AFTER the text around it is redacted. The
 * placeholder's own words ("settings") are then never a value's hiding place and never the pass's exemption, and a
 * placeholder a model or a server quotes is ordinary text.
 */
const PLACEHOLDER: unique symbol = Symbol("credential placeholder");

/** Text about to leave, as pieces: strings the pass redacts, placeholders it inserts whole. */
export type Parts = readonly (string | typeof PLACEHOLDER)[];

/** The bound a result is cut at and the hint that follows the cut; the shared redactor does the cutting. */
interface Bound {
	readonly limit: number;
	readonly suffix: string;
}

/**
 * The one function every model-facing string passes, and the only producer of ModelFacing; the input it exists for
 * is a 403 body quoting the key, which has no field shape to scrub by, so the known values are the handle. Nothing
 * rewrites text before it: an earlier pass with an older set leaves "[redacted]-tail" for a value the exit set holds
 * whole.
 *   one pass, the shared module's   -> URL cuts and known values are judged on the original text together
 *   placeholders are positional     -> adjacent text is redacted as one piece, a placeholder inserted after it
 *   the redactor cuts, never this   -> over the limit, the text from the first piece past the room passes as one
 *                                      string with the room left as its budget, so a value split by the cut is
 *                                      redacted whole and the cut marker counts every omitted character
 *   redaction swells the kept text  -> the room shrinks by the overflow and the redactor cuts again
 */
export function modelFacing(input: string | Parts, secrets: readonly string[] | Redactor, bound?: Bound): ModelFacing {
	const known = "redact" in secrets ? secrets : compiled(secrets);
	const pieces = coalesced(asParts(input));
	const text = (piece: string | typeof PLACEHOLDER): string =>
		piece === PLACEHOLDER ? CREDENTIAL_HEADER_PLACEHOLDER : known.redact(piece);
	const whole = pieces.map(text).join("");
	if (bound === undefined || whole.length <= bound.limit) {
		return whole as ModelFacing;
	}
	const hint = known.redact(bound.suffix);
	for (let room = bound.limit - hint.length; ; ) {
		let out = "";
		let used = 0;
		for (const [index, piece] of pieces.entries()) {
			const length = renderedText([piece]).length;
			if (used + length > room) {
				out += known.redact(renderedText(pieces.slice(index)), [], Math.max(room - used, 0));
				break;
			}
			out += text(piece);
			used += length;
		}
		if (out.length + hint.length <= bound.limit || room <= 0) {
			return `${out}${hint}` as ModelFacing;
		}
		room -= out.length + hint.length - bound.limit;
	}
}

function asParts(input: string | Parts): Parts {
	return typeof input === "string" ? [input] : input;
}

/** Adjacent strings as one, so the pass sees a value that spans serializer pieces (a key and its colon). */
function coalesced(parts: Parts): Parts {
	const out: (string | typeof PLACEHOLDER)[] = [];
	for (const part of parts) {
		const last = out[out.length - 1];
		if (typeof part === "string" && typeof last === "string") {
			out[out.length - 1] = last + part;
		} else {
			out.push(part);
		}
	}
	return out;
}

type Redactor = Pick<KnownSecrets, "redact">;

/** No values known: the URL layer alone, for a card value or a record the caller renders without a set. */
const NONE: Redactor = new KnownSecrets();

/** Compiled once per render call, so a whole payload costs one set() rather than one per string. */
function compiled(secrets: readonly string[]): Redactor {
	const known = new KnownSecrets();
	known.set(secrets);
	return known;
}

/**
 * What a record is to the scrub. Only a caller that holds a server entry says "entry" (shapeConfiguration for a
 * declared row's config, describeServerChange for its two snapshots); nothing is inferred from field names, because a
 * models record is request-body text the user wrote and may carry any name, baseUrl and headers included.
 */
type ScrubContext = "value" | "entry" | "headers";

/**
 * The one scrub over a whole value tree before anything renders: structure only, never text, which leaves as written
 * and is redacted once at the exit. Carrier (virtualKeyHeader) names flow DOWN the tree and callers add both
 * snapshots' (carriersOf), so a header is judged by every carrier in scope.
 *
 *   an ENTRY's `headers` record, credential values -> PLACEHOLDER (isCredentialHeader), rendered after the pass
 *   `headers` anywhere else                        -> request-body text the user wrote, rendered as written
 *   two keys the exit would render alike           -> the later one numbered, so neither entry replaces the other
 */
function scrubSecrets<T>(
	value: T,
	carriers: readonly string[] = [],
	context: ScrubContext = "value",
	preview: Redactor = NONE
): T {
	if (Array.isArray(value)) {
		return value.map((entry) => scrubSecrets(entry, carriers, context, preview)) as T;
	}
	if (isRecord(value)) {
		const inScope =
			context === "entry" && typeof value.virtualKeyHeader === "string"
				? [...carriers, value.virtualKeyHeader]
				: carriers;
		const seen = new Set<string>();
		return Object.fromEntries(
			Object.entries(value).map(([key, field]) => {
				let name = key;
				for (let ordinal = 2; seen.has(preview.redact(name)); ordinal += 1) {
					name = `${key} #${ordinal}`;
				}
				seen.add(preview.redact(name));
				return [
					name,
					context === "headers" && isCredentialHeader(key, inScope)
						? PLACEHOLDER
						: scrubSecrets(field, inScope, context === "entry" && key === "headers" ? "headers" : "value", preview),
				];
			})
		) as T;
	}
	return value;
}

const TRUNCATION_MARKER = '\n... [truncated: ask for fewer "sections", or inspect one model at a time]';

/** Whether JSON.stringify would print a value at all (undefined, functions, and foreign symbols vanish). */
function printable(value: unknown): boolean {
	return value === PLACEHOLDER || value === null || ["string", "number", "boolean", "object"].includes(typeof value);
}

/**
 * The text JSON.stringify would print for `value` (pretty with a two-space `indent`, compact with ""), as parts: the
 * placeholder node is a placeholder part between its quotes, everything else the same characters JSON.stringify
 * prints, including where it drops a value or prints "null" for one.
 */
function jsonParts(value: unknown, indent: string): Parts {
	const out: (string | typeof PLACEHOLDER)[] = [];
	const write = (node: unknown, depth: string): void => {
		const plain =
			typeof node === "object" && node !== null && typeof (node as { toJSON?: unknown }).toJSON === "function"
				? (node as { toJSON: () => unknown }).toJSON()
				: node;
		if (plain === PLACEHOLDER) {
			out.push('"', PLACEHOLDER, '"');
			return;
		}
		if (plain === null || typeof plain !== "object") {
			out.push(
				typeof plain === "string"
					? JSON.stringify(plain)
					: typeof plain === "number" && Number.isFinite(plain)
						? String(plain)
						: typeof plain === "boolean"
							? String(plain)
							: "null"
			);
			return;
		}
		const inner = depth + indent;
		const newline = indent === "" ? "" : "\n";
		if (Array.isArray(plain)) {
			if (plain.length === 0) {
				out.push("[]");
				return;
			}
			out.push("[", newline);
			plain.forEach((item, index) => {
				out.push(index === 0 ? inner : `,${newline}${inner}`);
				write(printable(item) ? item : null, inner);
			});
			out.push(newline, depth, "]");
			return;
		}
		const entries = Object.entries(plain as Record<string, unknown>).filter(([, item]) => printable(item));
		if (entries.length === 0) {
			out.push("{}");
			return;
		}
		out.push("{", newline);
		entries.forEach(([key, item], index) => {
			out.push(index === 0 ? inner : `,${newline}${inner}`, JSON.stringify(key), indent === "" ? ":" : ": ");
			write(item, inner);
		});
		out.push(newline, depth, "}");
	};
	if (!printable(value)) {
		return ["null"];
	}
	write(value, "");
	return out;
}

/** The parts as plain text with the placeholder spelled out; for a comparison, never for text that leaves. */
function renderedText(parts: Parts): string {
	return parts.map((part) => (part === PLACEHOLDER ? CREDENTIAL_HEADER_PLACEHOLDER : part)).join("");
}

/**
 * The result as the model reads it: scrubbed by structure (scrubSecrets), serialized into parts around its
 * placeholder nodes, then passed once through modelFacing with the reply bound and its hint.
 */
export function renderJson(value: unknown, secrets: readonly string[] = []): ModelFacing {
	const known = compiled(secrets);
	return modelFacing(jsonParts(scrubSecrets(value, [], "value", known), "  "), known, {
		limit: AGENT_RESULT_CHAR_LIMIT,
		suffix: TRUNCATION_MARKER,
	});
}

/** The diagnostics read: the report's snapshot plus the per-server rows the report withholds; text passes the exit. */
export function shapeDiagnostics(
	snapshot: DiagnosticsSnapshot,
	servers: readonly ServerStatus[],
	problems: DashboardState["diagnostics"],
	includeLogs: boolean
): Record<string, unknown> {
	return {
		extensionVersion: snapshot.extensionVersion,
		vscodeVersion: snapshot.vscodeVersion,
		platform: snapshot.platform,
		connectionState: snapshot.connectionState,
		modelCount: snapshot.modelCount,
		servers: servers.map((server) => ({
			label: server.label,
			baseUrl: server.baseUrl,
			state: server.state,
			servedModelCount: server.servedModelCount,
			lastChecked: server.lastChecked,
			hasApiKey: server.hasApiKey,
			hasOAuth: server.hasOAuth,
			...(server.state === "error"
				? {
						error: server.error,
						classification: server.classification,
						expected: server.expected,
						declaredModelCount: server.declaredModelCount,
					}
				: { hiddenByRemoval: server.hiddenByRemoval, modelInfoUnsupported: server.modelInfoUnsupported }),
		})),
		features: snapshot.featureFlags,
		mcpEntryCount: snapshot.mcpEntryCount,
		configurationProblems: problems,
		latestError:
			snapshot.latestError === undefined
				? undefined
				: {
						source: snapshot.latestError.source,
						timestamp: snapshot.latestError.timestamp,
						classification: snapshot.latestError.classification,
						message: snapshot.latestError.message,
					},
		...(includeLogs ? { recentLogs: snapshot.recentLogs } : {}),
	};
}

/** The configuration read; a row's error text can embed a response body and passes the exit like every string. */
export function shapeConfiguration(
	state: DashboardState,
	sections: readonly ConfigurationSection[] | undefined
): Record<string, unknown> {
	const wanted = new Set<ConfigurationSection>(
		sections ?? ["servers", "settings", "models", "hiddenGroups", "catalog", "usage"]
	);
	// The one place the read knows it holds an entry: a declared row's config carries the entry's custom headers.
	const servers = state.servers.map((server) =>
		server.origin === "declared" ? { ...server, config: scrubSecrets(server.config, [], "entry") } : server
	);
	return {
		...(wanted.has("servers") ? { servers, servedModelCount: state.servedModelCount } : {}),
		...(wanted.has("settings") ? { settings: state.settings } : {}),
		...(wanted.has("models") ? { models: state.models } : {}),
		...(wanted.has("hiddenGroups") ? { hiddenGroups: state.hiddenGroups } : {}),
		...(wanted.has("catalog") ? { catalog: state.settings.catalog } : {}),
		...(wanted.has("usage") ? { usage: state.usage } : {}),
	};
}

/** The dashboard's reply as the model reads it; a failure message can carry a probe's transport error. */
export function shapeSubmission(request: AgentRequest, submission: DashboardSubmission): Record<string, unknown> {
	switch (submission.outcome) {
		case "ok": {
			const reply = submission.reply;
			if (reply?.kind === "response") {
				return { method: request.method, ok: true, result: reply.payload };
			}
			return {
				method: request.method,
				ok: true,
				...(reply?.message !== undefined ? { note: reply.message } : {}),
			};
		}
		case "validation-error":
			return {
				method: request.method,
				ok: false,
				failureKind: submission.reply.failureKind,
				message: submission.reply.message,
				...(submission.reply.classification !== undefined ? { classification: submission.reply.classification } : {}),
				...(submission.issues !== undefined ? { issues: submission.issues } : {}),
			};
		case "ignored-malformed":
			return { method: request.method, ok: false, issues: submission.issues };
	}
}

/**
 * Identifiers from `detail` only, never a secret value, addressed to the calling model; the wiring throws it and the
 * exit's conversion redacts it like every thrown text.
 */
export function refusalText(reason: RefusalReason, detail: Readonly<Record<string, string>>): string {
	switch (reason) {
		case "unknown-setting":
			return `"${detail.setting}" is not a litellm-vscode-chat setting. Read the configuration tool's "settings" section for the names.`;
		case "setting-owned-by-tool":
			return `"${detail.setting}" is not changed through litellm_set_setting; use the ${detail.tool} tool.`;
		case "agent-tools-switch":
			return `"${detail.setting}" switches the agent tools themselves and can only be changed by the user.`;
		case "server-not-found":
			return `No servers entry is labeled "${detail.label}". Read the configuration tool's "servers" section for the labels.`;
		case "server-not-declared":
			return `"${detail.label}" is a provider group outside the servers setting; call litellm_remove_server with action "hide" and its baseUrl.`;
		case "external-group-not-found":
			return `No external provider group is at "${displayUrl(detail.baseUrl ?? "")}"${detail.label !== undefined ? ` labeled "${detail.label}"` : ""}.`;
		case "external-group-ambiguous":
			return `More than one provider group is labeled "${detail.label}" at "${displayUrl(detail.baseUrl ?? "")}"; they differ only in credentials this tool does not show. Act on it from the dashboard.`;
		case "hidden-group-not-found":
			return `No removed group is labeled "${detail.label}" at "${displayUrl(detail.baseUrl ?? "")}". Read the configuration tool's "hiddenGroups" section; only groups with reason "removed" can be unhidden.`;
		case "secret-locations-unproven":
			return `The entry "${detail.label}" has not finished loading its secret locations; call again in a moment.`;
		case "secret-value-refused":
			return `Tool input carried a secret value for ${detail.fields}, which agentTools.secretValues.enabled does not allow. Omit "value": the user is asked to type it.`;
		case "kept-secret-destination-change":
			return (
				`The change moves "${detail.label}" to another destination while keeping ${detail.fields}. A stored ` +
				"secret never follows a changed destination (the base URL; for an OAuth client secret, the token URL and " +
				`client id): set ${detail.fields} again (omit "value" and the user is asked to type it), or clear it.`
			);
		case "base-url-required":
			return `"${detail.label}" needs a baseUrl.`;
		case "feature-model-not-set":
			return `No model is picked for ${detail.feature}; set "${detail.feature}.model" first.`;
		case "model-not-found":
			return `Server "${detail.server}" serves no model "${detail.model}". Read the configuration tool's "models" section.`;
		case "model-ambiguous":
			return `More than one row serves "${detail.model}" under the label "${detail.server}" (scopeKeys ${detail.scopeKeys}). Pass the scopeKey of the row you mean, from the configuration tool's "models" section.`;
		case "nothing-to-change":
			return `The record for "${detail.key}" already reads this way; nothing to change.`;
		case "language-filter-one-half":
			return `Set "${detail.setting}" one half per call: { "mode": ... } in one call and { "languages": [...] } in another, like the dashboard's two rows.`;
		case "credential-header-placeholder":
			return `headers ${detail.headers} carry the placeholder litellm_configuration shows for a credential header, but "${detail.label}" stores no such header to keep. Give the value, or leave the header out.`;
		case "carrier-header-kept":
			return `The change drops virtualKeyHeader ${detail.carriers} from "${detail.label}" while headers still carry it, so its value would stop counting as a credential. Send headers without ${detail.carriers}, or keep the virtualKeyHeader.`;
	}
}

// ---------------------------------------------------------------------------
// Confirmation cards: what the user sees before a write runs
// ---------------------------------------------------------------------------

/** The fence outruns every backtick run in the content, so an agent-written key cannot close the card early. */
function fenced(lines: readonly (string | Parts)[]): Parts {
	const body: (string | typeof PLACEHOLDER)[] = [];
	lines.forEach((line, index) => {
		if (index > 0) {
			body.push("\n");
		}
		body.push(...asParts(line));
	});
	let longestRun = 0;
	for (const part of body) {
		if (typeof part === "string") {
			for (const run of part.matchAll(/`+/g)) {
				longestRun = Math.max(longestRun, run[0].length);
			}
		}
	}
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	return [`${fence}\n`, ...body, `\n${fence}`];
}

/**
 * A card value with its note when the exit will hide part of it: a URL's credentials or a credential header are
 * written as given but never displayed, so the user is told the value holds more than the card shows. The preview
 * decides the note; it never rewrites what leaves.
 */
function shown(value: unknown, preview: Redactor = NONE): Parts {
	return shownAs(value, scrubSecrets(value), preview);
}

function shownAs(raw: unknown, scrubbed: unknown, preview: Redactor): Parts {
	const rendered = jsonParts(scrubbed, "");
	const text = renderedText(rendered);
	return preview.redact(text) === text && text === (JSON.stringify(raw) ?? "null")
		? rendered
		: [...rendered, ` ${l10n.t("(carries text the card does not show, such as URL credentials)")}`];
}

function valueLabels(): { readonly before: string; readonly after: string } {
	const before = l10n.t("before:");
	const after = l10n.t("after:");
	const width = Math.max(before.length, after.length) + 1;
	return { before: before.padEnd(width), after: after.padEnd(width) };
}

/** A setting change: the full key, the scope the write lands in, and both values. */
export function describeSettingChange(setting: string, before: unknown, after: unknown, scope: string | null): Parts {
	const labels = valueLabels();
	return fenced([
		`litellm-vscode-chat.${setting}${scope !== null ? `  ${l10n.t("(configured in: {0})", scope)}` : ""}`,
		[labels.before, ...shown(before)],
		[labels.after, ...(after === null ? [l10n.t("(removed from its configured scope)")] : shown(after))],
	]);
}

/** A record edit: the matcher key and the record before and after, for the scope or entry it lands in. */
export function describeRecordChange(
	kind: "capabilities" | "parameters",
	key: string,
	before: unknown,
	after: unknown,
	target: string,
	known: readonly string[] = []
): Parts {
	const preview = compiled(known);
	const labels = valueLabels();
	return fenced([
		`models.${kind}["${key}"]  (${target})`,
		[labels.before, ...(before === undefined ? [l10n.t("(absent)")] : shown(before, preview))],
		[labels.after, ...(after === undefined ? [l10n.t("(removed)")] : shown(after, preview))],
	]);
}

/**
 * The virtualKeyHeader names of both snapshots of a server change: a header the before side declared a carrier is
 * still a credential on the after side that renamed or cleared the carrier.
 */
function carriersOf(...snapshots: readonly (Readonly<Record<string, unknown>> | undefined)[]): string[] {
	return snapshots.flatMap((snapshot) =>
		typeof snapshot?.virtualKeyHeader === "string" ? [snapshot.virtualKeyHeader] : []
	);
}

/**
 * A server save: field names that change, never their values for secrets. A moved base URL is spelled out because it
 * decides where credentials go.
 */
export function describeServerChange(
	label: string,
	before: Readonly<Record<string, unknown>> | undefined,
	after: Readonly<Record<string, unknown>>,
	secretLines: readonly string[],
	prompts: readonly SecretPrompt[],
	known: readonly string[] = []
): Parts {
	const preview = compiled(known);
	const lines: Parts[] = [
		[before === undefined ? l10n.t('new servers entry "{0}"', label) : l10n.t('servers entry "{0}"', label)],
	];
	const carriers = carriersOf(before, after);
	const scrubbedBefore = scrubSecrets(before ?? {}, carriers, "entry", preview);
	const scrubbedAfter = scrubSecrets(after, carriers, "entry", preview);
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
	for (const key of [...keys].sort()) {
		const previous = before?.[key];
		const next = after[key];
		// Compared raw, rendered through shownAs(): dropping or replacing a URL's credentials is a change the card must
		// list, and the side that carries them says so.
		if (JSON.stringify(previous) !== JSON.stringify(next)) {
			const shownPrevious =
				previous === undefined ? [l10n.t("(absent)")] : shownAs(previous, scrubbedBefore[key], preview);
			const shownNext = next === undefined ? [l10n.t("(absent)")] : shownAs(next, scrubbedAfter[key], preview);
			// Both sides can render alike when only the hidden text changed (one password replaced by another), so that
			// case is named too.
			const hiddenChanged =
				preview.redact(renderedText(shownPrevious)) === preview.redact(renderedText(shownNext))
					? ` ${l10n.t("(the hidden text changed)")}`
					: "";
			lines.push([`${key}: `, ...shownPrevious, " -> ", ...shownNext, hiddenChanged]);
		}
	}
	for (const line of secretLines) {
		lines.push([line]);
	}
	for (const prompt of prompts) {
		lines.push([l10n.t("{0}: you will be asked to type it (stored in {1})", prompt.field, prompt.location)]);
	}
	if (lines.length === 1) {
		lines.push([l10n.t("(no field changes)")]);
	}
	return fenced(lines);
}

/** An adoption: which external group is copied, under which label, and where each copied secret lands. */
export function describeAdoption(
	source: { readonly label: string; readonly baseUrl: string },
	label: string,
	locations: Readonly<Partial<Record<string, "settings" | "secure">>>
): Parts {
	const shownUrl = displayUrl(source.baseUrl);
	const heading = l10n.t('adopt provider group "{0}" at {1} as servers entry "{2}"', source.label, shownUrl, label);
	const lines = [
		shownUrl === source.baseUrl
			? heading
			: `${heading} ${l10n.t("(the stored URL carries credentials the card does not show; they are copied as-is)")}`,
	];
	for (const field of ["apiKey", "oauthClientSecret", "virtualKeyValue"]) {
		lines.push(l10n.t("{0}: copied to {1} storage if the group holds one", field, locations[field] ?? "secure"));
	}
	return fenced(lines);
}

export function describeAction(action: string, target: string | undefined): Parts {
	return fenced([target === undefined ? action : `${action}: ${target}`]);
}
