import * as vscode from "vscode";

/** Constructor shape of the proposed LanguageModelThinkingPart class. */
export type ThinkingPartCtor = new (text: string, id?: string, metadata?: unknown) => vscode.LanguageModelResponsePart;

export interface ThinkingPartProbe {
	ctor: ThinkingPartCtor | undefined;
	error?: string;
}

/**
 * LanguageModelThinkingPart is a proposed API class: present at runtime on
 * current hosts but absent from the stable typings, and hosts may expose
 * proposed classes behind throwing getters, so the property read itself is
 * guarded.
 */
export function probeThinkingPartCtor(host: object): ThinkingPartProbe {
	try {
		const ctor: unknown = Reflect.get(host, "LanguageModelThinkingPart");
		return { ctor: typeof ctor === "function" ? (ctor as ThinkingPartCtor) : undefined };
	} catch (e) {
		return { ctor: undefined, error: String(e) };
	}
}

// Probed once at module load; the streaming path and the history-replay path
// share this result.
const probe = probeThinkingPartCtor(vscode);

/** The host's LanguageModelThinkingPart constructor, or undefined when the host does not expose one. */
export const thinkingPartCtor: ThinkingPartCtor | undefined = probe.ctor;

/** Set when the probe threw instead of returning a constructor; surfaced through logThinkingPartProbeErrorOnce. */
const thinkingPartProbeError: string | undefined = probe.error;

let loggedMissingThinkingSupport = false;
let loggedProbeError = false;

/**
 * Log, once per session, that the host cannot display thinking parts. The
 * reasoning output itself is dropped rather than emitted as text: text parts
 * round-trip into chat history and would pollute the replayed conversation.
 */
export function logMissingThinkingPartSupportOnce(log: (message: string) => void): void {
	if (loggedMissingThinkingSupport) {
		return;
	}
	loggedMissingThinkingSupport = true;
	log("Host does not support thinking parts; reasoning output will not be displayed");
}

/**
 * Log, once per session, that the constructor probe threw. Every
 * StreamProcessor construction reports here, so the guard keeps a host with a
 * throwing getter from being re-logged on each request. Tests inject the
 * error; production callers use the module probe result.
 */
export function logThinkingPartProbeErrorOnce(
	log: (message: string, data?: unknown) => void,
	error: string | undefined = thinkingPartProbeError
): void {
	if (loggedProbeError || error === undefined) {
		return;
	}
	loggedProbeError = true;
	log("LanguageModelThinkingPart probe failed", { error });
}

/** Test hook: lets the once-per-session thinking logs fire again. */
export function resetThinkingPartLogOnce(): void {
	loggedMissingThinkingSupport = false;
	loggedProbeError = false;
}
