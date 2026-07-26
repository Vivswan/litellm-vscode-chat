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

/** Set when the probe threw instead of returning a constructor; callers may log it. */
export const thinkingPartProbeError: string | undefined = probe.error;
