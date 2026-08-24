/**
 * The per-entry credential-rotation counter the published MCP definitions
 * carry as their version. VS Code treats a changed version as "this server's
 * tools may have changed"; a rotation is exactly that, because the session the
 * editor opens next will authenticate with a different credential.
 *
 * Two rotation signals feed it, and both are OBSERVED rather than reported by
 * their writers: SecretStorage's own change event covers every secure-side
 * write (the palette command, a dashboard save, an import, an adoption, and
 * another window's write alike), and a settings-side edit shows up as a change
 * in the entry's credential digest across servers-setting revisions. No write
 * site has to remember to call anything, which is the point - a hook a caller
 * can forget is not a guard.
 *
 * Secrets discipline: the digests are one-way, live in memory only, and never
 * reach storage, logs, or a view. Only the counters persist, and a count of
 * rotations tells an attacker nothing about what rotated.
 */

import { MCP_ENTRY_VERSIONS_KEY } from "../../../shared/config/storageKeys";
import { OPTIONAL_ENTRY_FIELDS } from "../../../shared/serverEntry";
import { fingerprint } from "../../../shared/util/fingerprint";
import { isRecord } from "../../../shared/util/json";
import type { DeclaredServer } from "../../servers/serverSync/setting";

/** The Memento slice the counter uses; injectable so the store is testable without a host. */
export interface VersionStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

/** The persisted shape: label -> count. Untrusted on read, like every other globalState value. */
function readCounters(store: VersionStore): Record<string, number> {
	const raw = store.get<unknown>(MCP_ENTRY_VERSIONS_KEY);
	if (!isRecord(raw)) {
		return {};
	}
	const counters: Record<string, number> = {};
	for (const [label, value] of Object.entries(raw)) {
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
			counters[label] = value;
		}
	}
	return counters;
}

/**
 * The digest of everything about an entry that decides what a resolve sends:
 * the inline secret values, the non-secret auth text that shapes them (a token
 * URL, a client id, scopes, the header a virtual key rides in), the entry's
 * own custom headers, and its base URL. Deliberately WIDER than "secrets":
 * what matters to the editor is whether the next session would authenticate
 * differently, and renaming the virtual-key header does that as surely as
 * rotating its value.
 *
 * `baseUrl` is in here because it AUTHORIZES rather than merely addresses: it
 * is the origin an endpoint must match to be credentialed at all, and the
 * destination a stored secret's ownership stamp is compared against. With a
 * custom `mcp.url` the published endpoint does not move when the base URL
 * does, so without this a base URL edit would flip both verdicts while the
 * descriptor stayed identical and nothing told the editor to re-resolve.
 *
 * JSON-encoded before hashing so two different field sets cannot serialize
 * identically, and field-keyed so moving one value between fields counts as
 * the change it is.
 */
function credentialDigestOf(entry: DeclaredServer): string {
	const parts: Record<string, unknown> = { baseUrl: entry.baseUrl };
	for (const field of OPTIONAL_ENTRY_FIELDS) {
		const value = entry[field.id];
		if (value !== undefined) {
			parts[field.id] = value;
		}
	}
	if (entry.headers !== undefined) {
		parts.headers = entry.headers;
	}
	return `h:${fingerprint(JSON.stringify(parts))}`;
}

/**
 * The counters and the inline-secret rotation detector. Detection is
 * synchronous and side-effect-free beyond its own digests; persisting a
 * rotation is the caller's separate `bump`, so seeding the digests at
 * activation cannot accidentally write anything.
 */
export class McpVersionCounters {
	/** In memory only, and never persisted or logged: these summarize secret material. */
	private readonly digests = new Map<string, string>();

	/**
	 * The tail of the persisted writes. Every bump is a read-modify-write of one
	 * shared record, and the events that trigger them (a secrets change naming
	 * several entries, a settings import rotating a batch) arrive without being
	 * awaited, so unserialized writes would interleave and drop increments -
	 * leaving a counter that can stall or regress.
	 */
	private writes: Promise<unknown> = Promise.resolve();

	constructor(private readonly store: VersionStore) {}

	/** The version to publish for `label`; an entry never yet rotated publishes 0. */
	versionOf(label: string): number {
		return readCounters(this.store)[label] ?? 0;
	}

	/** Record one observed rotation of `label`'s credentials, queued behind any write still in flight. */
	async bump(label: string): Promise<void> {
		const increment = async (): Promise<void> => {
			const counters = readCounters(this.store);
			await this.store.update(MCP_ENTRY_VERSIONS_KEY, { ...counters, [label]: (counters[label] ?? 0) + 1 });
		};
		// Both arms run it: a failed predecessor must not cancel this rotation.
		const run = this.writes.then(increment, increment);
		this.writes = run.then(
			() => undefined,
			() => undefined
		);
		await run;
	}

	/**
	 * Fold in this pass's entries and return the labels whose resolved
	 * credentials would have changed since the last pass. Labels the setting no
	 * longer declares are forgotten (a label that comes back is a new pairing,
	 * and its stored counter still carries the rotations it accumulated).
	 *
	 * The FIRST sighting of a label never counts: activation has no previous
	 * digest to compare against, and reading "we just started" as a rotation
	 * would announce one in every window. That makes the activation-time call
	 * the seeding call, by construction rather than by a flag. Every entry
	 * always produces a digest (it always has a base URL), so absence in the
	 * map means "never seen" and nothing else.
	 *
	 * A REPORTED label's new digest commits right here, so each rotation is
	 * reported exactly once. If the caller's counter write then fails, nothing
	 * recovers it - deliberately: the version is an opaque change token nobody
	 * reads as a count, so the only cost is the editor serving the previous
	 * cached credential until the NEXT rotation bumps the counter anyway. The
	 * failure self-corrects on its own next beat, and recovery machinery for a
	 * self-healing failure earned less than it cost.
	 */
	observeCredentials(entries: readonly DeclaredServer[]): readonly string[] {
		const rotated: string[] = [];
		const seen = new Set<string>();
		for (const entry of entries) {
			seen.add(entry.label);
			const digest = credentialDigestOf(entry);
			const previous = this.digests.get(entry.label);
			if (previous !== digest) {
				this.digests.set(entry.label, digest);
				if (previous !== undefined) {
					rotated.push(entry.label);
				}
			}
		}
		for (const label of [...this.digests.keys()]) {
			if (!seen.has(label)) {
				this.digests.delete(label);
			}
		}
		return rotated;
	}
}
