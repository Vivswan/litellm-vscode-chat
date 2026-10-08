import { z } from "zod";
import type { TransportErrorKind } from "../../shared/errorClassification";
import { isTransportErrorKind, transportClassificationOf } from "../../shared/errorClassification";
import { MirroredError } from "../../shared/mirroredError";
import type { NonChatMode } from "../../shared/serverEntry";
import { isNonChatMode } from "../../shared/serverEntry";
import { MODEL_GROUP_INFO_PATH, MODEL_INFO_PATH, MODELS_PATH } from "../transport/clients";

const mint = Symbol("classification");

/**
 * Minted only inside this module (parseWire's rendering of a schema issue, logFailure's read of a MirroredError's own
 * classification), and recognized by the writer by its private field, never by text: the constructor demands this
 * module's token (so an instance's `.constructor` mints nothing), no string of a caller's choosing can pose as one,
 * Object.assign cannot carry one onto another object, and a replaced toString is never consulted.
 */
class ClassificationText {
	readonly #text: string;
	constructor(token: typeof mint, text: string) {
		if (token !== mint) {
			throw new TypeError("a Classification is minted only by discoveryLog.ts");
		}
		this.#text = text;
	}
	static isOne(value: unknown): value is ClassificationText {
		return typeof value === "object" && value !== null && #text in value;
	}
	static textOf(classification: ClassificationText): string {
		return classification.#text;
	}
}

export type Classification = ClassificationText;

type DiscoveryEndpoint = typeof MODEL_INFO_PATH | typeof MODELS_PATH | typeof MODEL_GROUP_INFO_PATH;

type FailureKind = TransportErrorKind | "unclassified";

/** What a boundary's error-level line may say about the value it caught; logFailure derives it. */
interface ClassifiedFailure {
	kind: FailureKind;
	status?: number;
	classification?: Classification;
}

/**
 * The boundaries that log a caught value at error level, one key per boundary: a message templated over the value
 * would carry its text past the data vocabulary.
 */
export type FailureLineMessage =
	| "Chat request failed"
	| "Consult tool consultation failed"
	| "MCP resolve failed"
	| "Commit message generation failed"
	| "Pull request description generation failed"
	| "Review failed"
	| "Review reply failed"
	| "Quick fix fallback failed";

/**
 * Every discovery and registration log line and every boundary failure line, with the data each carries, because
 * these lines reach the public issue report. A message is a key here and a value is a count, a flag, a constant, or a
 * Classification, so no response value has a type here.
 */
interface DiscoveryLogLines extends Record<FailureLineMessage, ClassifiedFailure> {
	"Fetching models": { endpoint: DiscoveryEndpoint };
	"Parsed model/info response": { modelCount: number };
	"Parsed models listing": { modelCount: number };
	"Successfully fetched models": { modelCount: number };
	"Registered models": {
		modelCount: number;
		entryCount: number;
		deploymentModels: number;
		bareModels: number;
		groupModels: number;
	};
	"Skipping malformed provider entry": { index: number; rejection: Classification };
	"Skipping malformed model/info entry": { index: number; modelInfo: Classification; listing: Classification };
	"Skipping malformed models entry": { index: number; rejection: Classification };
	"Skipping blocked model/info entry": { index: number };
	"Skipping non-chat model/info entry": { mode: NonChatMode };
	"Registering included non-chat model/info entry": { mode: NonChatMode };
	"model/info returned data but no usable models; falling back": { dataLength: number };
	"model/info response has no data array; falling back": { rejection: Classification };
	"model/info failed; falling back to the models listing": { expected: boolean; kind: FailureKind; status?: number };
	"Parsed model_group/info response": { groupCount: number };
	"Skipping malformed model_group/info entry": { index: number; rejection: Classification };
	"model_group/info response has no data array; menus follow the deployment flags": { rejection: Classification };
	"model_group/info failed; menus follow the deployment flags": { kind: FailureKind; status?: number };
	"Model discovery failed for provider group": {
		expected: boolean;
		silent: boolean;
		kind: FailureKind;
		status?: number;
	};
}

type DiscoveryLogMessage = keyof DiscoveryLogLines;

/** Rejects keys beyond the line's own, which excess-property checks skip for computed keys and variables. */
type Exactly<Data, Shape> = Data & { readonly [K in Exclude<keyof Data, keyof Shape>]: never };

export type DiscoveryLog = <M extends DiscoveryLogMessage, Data extends DiscoveryLogLines[M]>(
	message: M,
	data: Exactly<Data, DiscoveryLogLines[M]>
) => void;

type ValueKind = "number" | "boolean" | "classification" | "mode" | "endpoint" | "failureKind";

const ACCEPTS: { readonly [K in ValueKind]: (value: unknown) => boolean } = {
	number: (value) => typeof value === "number",
	boolean: (value) => typeof value === "boolean",
	classification: ClassificationText.isOne,
	mode: isNonChatMode,
	endpoint: (value) => value === MODEL_INFO_PATH || value === MODELS_PATH || value === MODEL_GROUP_INFO_PATH,
	failureKind: (value) => value === "unclassified" || isTransportErrorKind(value),
};

const FAILURE_SHAPE = { kind: "failureKind", status: "number", classification: "classification" } as const;

/**
 * The writer admits only these keys, each only through its kind's closed vocabulary, so a value the type system was
 * talked past (a narrowed alias, a defined-in property, a string behind a branded type) never reaches the sink; a
 * present value it refuses leaves the fixed [rejected] marker, so the mistake shows without its value.
 */
const LINE_SHAPES: {
	readonly [M in DiscoveryLogMessage]: { readonly [K in keyof DiscoveryLogLines[M]]-?: ValueKind };
} = {
	"Fetching models": { endpoint: "endpoint" },
	"Parsed model/info response": { modelCount: "number" },
	"Parsed models listing": { modelCount: "number" },
	"Successfully fetched models": { modelCount: "number" },
	"Registered models": {
		modelCount: "number",
		entryCount: "number",
		deploymentModels: "number",
		bareModels: "number",
		groupModels: "number",
	},
	"Skipping malformed provider entry": { index: "number", rejection: "classification" },
	"Skipping malformed model/info entry": { index: "number", modelInfo: "classification", listing: "classification" },
	"Skipping malformed models entry": { index: "number", rejection: "classification" },
	"Skipping blocked model/info entry": { index: "number" },
	"Skipping non-chat model/info entry": { mode: "mode" },
	"Registering included non-chat model/info entry": { mode: "mode" },
	"model/info returned data but no usable models; falling back": { dataLength: "number" },
	"model/info response has no data array; falling back": { rejection: "classification" },
	"model/info failed; falling back to the models listing": {
		expected: "boolean",
		kind: "failureKind",
		status: "number",
	},
	"Parsed model_group/info response": { groupCount: "number" },
	"Skipping malformed model_group/info entry": { index: "number", rejection: "classification" },
	"model_group/info response has no data array; menus follow the deployment flags": { rejection: "classification" },
	"model_group/info failed; menus follow the deployment flags": { kind: "failureKind", status: "number" },
	"Model discovery failed for provider group": {
		expected: "boolean",
		silent: "boolean",
		kind: "failureKind",
		status: "number",
	},
	"Chat request failed": FAILURE_SHAPE,
	"Consult tool consultation failed": FAILURE_SHAPE,
	"MCP resolve failed": FAILURE_SHAPE,
	"Commit message generation failed": FAILURE_SHAPE,
	"Pull request description generation failed": FAILURE_SHAPE,
	"Review failed": FAILURE_SHAPE,
	"Review reply failed": FAILURE_SHAPE,
	"Quick fix fallback failed": FAILURE_SHAPE,
};

/** The one path from a discovery line to the host's logger. */
export function discoveryLineWriter(sink: (message: string, data: unknown) => void): DiscoveryLog {
	return (message, data) => {
		const line: Record<string, number | boolean | string> = {};
		for (const [key, kind] of Object.entries<ValueKind>(LINE_SHAPES[message])) {
			const value: unknown = (data as Record<string, unknown>)[key];
			if (value === undefined) {
				continue;
			}
			if (!ACCEPTS[kind](value)) {
				line[key] = "[rejected]";
			} else {
				line[key] = ClassificationText.isOne(value)
					? ClassificationText.textOf(value)
					: (value as number | boolean | string);
			}
		}
		sink(message, line);
	};
}

export type WireParse<T> =
	| { readonly success: true; readonly data: T }
	| { readonly success: false; readonly rejection: Classification };

export function parseWire<T extends z.ZodType>(schema: T, value: unknown): WireParse<z.output<T>> {
	const result = schema.safeParse(value, { reportInput: true });
	if (result.success) {
		return { success: true, data: result.data };
	}
	const rejection = result.error.issues.map((issue) => renderIssue(schema, issue)).join("; ");
	return { success: false, rejection: new ClassificationText(mint, rejection) };
}

/**
 * What a discovery failure may say about itself: its transport kind and status, and only when it is this
 * repository's own error class, because a `kind` or `logClassification` read off an arbitrary throw is text the
 * thrower chose. Anything else is unclassified.
 */
export function failureKindOf(error: unknown): { kind: FailureKind; status?: number } {
	const classification = error instanceof MirroredError ? transportClassificationOf(error) : undefined;
	if (classification === undefined) {
		return { kind: "unclassified" };
	}
	return {
		kind: classification.kind,
		...(classification.status !== undefined ? { status: classification.status } : {}),
	};
}

/** Logger.failure's shape: the line's data for the channel and the buffer, the caught value for the recorder only. */
export type FailureSink = (message: string, data: unknown, error: unknown) => void;

/**
 * A boundary's one error-level line for a caught value. The value's own terse classification rides along under the
 * same guard as its kind, so the errors that carry no transport kind (a routing refusal, a tool-pairing rejection)
 * stay apart in an issue report.
 */
export function logFailure(sink: FailureSink, message: FailureLineMessage, error: unknown): void {
	const classification = ownClassificationOf(error);
	discoveryLineWriter((text, line) => sink(text, line, error))(message, {
		...failureKindOf(error),
		...(classification !== undefined ? { classification: new ClassificationText(mint, classification) } : {}),
	});
}

/** Total like failureKindOf's read of the kind: a getter that throws must not replace the failure being logged. */
function ownClassificationOf(error: unknown): string | undefined {
	try {
		return error instanceof MirroredError ? error.logClassification : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every word is the schema's (a static key, an issue code), a JSON type word for the expected or refused type, or the
 * [key] and [type] placeholders, never the value: a record key, a custom message, or a refinement's `expected` could
 * carry the value, so none is rendered.
 *
 *   { id: 1, mode: "sk-live-abc" } against providerEntrySchema -> provider: expected string, received undefined
 *   "bogus"                                                     -> expected object, received string
 *   { "sk-live-abc": "x" } against a z.record                   -> [key]: expected number, received string
 */
function renderIssue(schema: z.ZodType, issue: z.core.$ZodIssue): string {
	const path = renderPath(schema, issue.path);
	const at = path.length > 0 ? `${path}: ` : "";
	if (issue.code !== "invalid_type") {
		return `${at}${issue.code}`;
	}
	const expected = JSON_KINDS.has(issue.expected) ? issue.expected : "[type]";
	return `${at}expected ${expected}, received ${jsonKindOf(issue.input)}`;
}

function renderPath(schema: z.ZodType, path: readonly PropertyKey[]): string {
	const segments: string[] = [];
	let shape = objectShape(schema);
	for (const key of path) {
		const field = typeof key === "string" && shape !== undefined && Object.hasOwn(shape, key) ? shape[key] : undefined;
		segments.push(field === undefined || typeof key !== "string" ? "[key]" : key);
		shape = field === undefined ? undefined : objectShape(field);
	}
	return segments.join(".");
}

function objectShape(schema: z.core.$ZodType): Readonly<Record<string, z.core.$ZodType>> | undefined {
	let current: z.core.$ZodType = schema;
	for (;;) {
		if (current instanceof z.ZodObject) {
			return current.shape;
		}
		if (current instanceof z.ZodPipe) {
			current = current.in;
		} else if (
			current instanceof z.ZodOptional ||
			current instanceof z.ZodNullable ||
			current instanceof z.ZodCatch ||
			current instanceof z.ZodDefault
		) {
			current = current.unwrap();
		} else {
			return undefined;
		}
	}
}

const JSON_KINDS: ReadonlySet<string> = new Set([
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"null",
	"undefined",
]);

function jsonKindOf(value: unknown): string {
	if (value === null) {
		return "null";
	}
	return Array.isArray(value) ? "array" : typeof value;
}
