import * as vscode from "vscode";

/** Constructor shape of the LanguageModelDataPart class. */
export type DataPartCtor = new (data: Uint8Array, mimeType: string) => vscode.LanguageModelResponsePart;

export interface DataPartProbe {
	ctor: DataPartCtor | undefined;
	error?: string;
}

/**
 * LanguageModelDataPart is probed the same way as LanguageModelThinkingPart:
 * the class sits in current stable typings, but older hosts may lack it and
 * hosts have been observed exposing part classes behind throwing getters, so
 * the property read itself is guarded and its absence turns the media
 * feature off instead of crashing the stream.
 */
export function probeDataPartCtor(host: object): DataPartProbe {
	try {
		const ctor: unknown = Reflect.get(host, "LanguageModelDataPart");
		return { ctor: typeof ctor === "function" ? (ctor as DataPartCtor) : undefined };
	} catch (e) {
		return { ctor: undefined, error: String(e) };
	}
}

// Probed once at module load; every StreamProcessor shares this result.
const probe = probeDataPartCtor(vscode);

/** The host's LanguageModelDataPart constructor, or undefined when the host does not expose one. */
export const dataPartCtor: DataPartCtor | undefined = probe.ctor;

/** Set when the probe threw instead of returning a constructor; surfaced through logDataPartProbeErrorOnce. */
const dataPartProbeError: string | undefined = probe.error;

let loggedMissingDataPartSupport = false;
let loggedProbeError = false;

/**
 * Log, once per session, that the host cannot display data parts. The media
 * payload itself is dropped, matching the pre-feature behavior of ignoring
 * media delta fields entirely.
 */
export function logMissingDataPartSupportOnce(log: (message: string) => void): void {
	if (loggedMissingDataPartSupport) {
		return;
	}
	loggedMissingDataPartSupport = true;
	log("Host does not support data parts; generated media will not be displayed");
}

/**
 * Log, once per session, that the constructor probe threw. Every
 * StreamProcessor construction reports here, so the guard keeps a host with a
 * throwing getter from being re-logged on each request. Tests inject the
 * error; production callers use the module probe result.
 */
export function logDataPartProbeErrorOnce(
	log: (message: string, data?: unknown) => void,
	error: string | undefined = dataPartProbeError
): void {
	if (loggedProbeError || error === undefined) {
		return;
	}
	loggedProbeError = true;
	log("LanguageModelDataPart probe failed", { error });
}

/** Test hook: lets the once-per-session data-part logs fire again. */
export function resetDataPartLogOnce(): void {
	loggedMissingDataPartSupport = false;
	loggedProbeError = false;
}
