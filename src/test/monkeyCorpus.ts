/**
 * Corpus of monkey walks that once failed the interaction fuzzer. Entries replay
 * at the start of every docker-monkey run, before the random walks, so a bug
 * found by a nightly seed stays found after the generator changes. To add one,
 * take the "minimal failing corpus entry" JSON from the failure report and
 * append it with a name referencing the issue. Labels inside actions are
 * abstract tokens; the executor mints fresh labels on every replay, so entries
 * never collide with the host's add-only groups.
 */

import type { MonkeyCorpusEntry } from "./monkeyFuzz";

export const MONKEY_CORPUS: MonkeyCorpusEntry[] = [
	{
		// FUZZ_SEED=1 walk 0, shrunk: a debounced sync pass re-read a stale
		// fingerprint map from globalState, re-added the group, and misclassified
		// the duplicate rejection as a foreign name conflict. The chat stays in the
		// trace because the failure was timing-dependent.
		name: "oauth-declare-lost-fingerprint-update",
		actions: [
			{ kind: "chat", verb: "stream", a: 4, b: 0, pick: 633 },
			{ kind: "declare-server", label: "s2", credential: "oauth" },
		],
	},
	{
		// FUZZ_SEED=575380 walk 0, re-expanded: a removed entry's group is
		// tombstoned and its models leave the host list, but the oracle's
		// model-count floors kept counting every healthy ever-synced group. This
		// trace replays the chain - a healthy group, its explicit removal, then a
		// declare whose probes must accept the hidden group's absence.
		name: "removed-entry-tombstone-hides-healthy-group",
		actions: [
			{ kind: "declare-server", label: "s1", credential: "oauth" },
			{ kind: "remove-server", label: "s1" },
			{ kind: "declare-server", label: "s2", credential: "bad-key" },
		],
	},
	{
		// FUZZ_SEED=466017 walk 21, shrunk (#220): a remove's sync pass resolved the
		// label's base URL from a reverted globalState ledger read, so the removal
		// carried no URL, no tombstone was written, and the group's models never
		// left the host list. Storage-timing-dependent, so this trace guards the
		// sequence rather than reproducing the revert; the unit suites pin the
		// revert itself with simulated stale reads.
		name: "stale-ledger-remove-shortly-after-declare",
		actions: [
			{ kind: "sync-now" },
			{ kind: "sync-now" },
			{ kind: "chat", verb: "echo", a: 98538, b: 294, pick: 642 },
			{ kind: "dashboard-junk", payload: { type: "setHeaders", value: { h: { nested: 4 } } } },
			{ kind: "sync-now" },
			{ kind: "sync-now" },
			{ kind: "declare-server", label: "s1", credential: "inline" },
			{ kind: "remove-server", label: "s1" },
			{ kind: "chat", verb: "echo", a: 60891, b: 694, pick: 187 },
			{ kind: "set-model-parameters", valid: true, serial: 11 },
			{ kind: "set-model-parameters", valid: true, serial: 12 },
		],
	},
	{
		// FUZZ_SEED=250710 walk 1, shrunk: an entry-declared model must LEAVE on a
		// redeclare - the mutated base URL stops identifying the live group, so the
		// entry's per-entry configuration no longer reaches it, exactly like
		// per-entry parameters going inactive.
		name: "redeclare-detaches-entry-declared-model",
		actions: [
			{
				kind: "declare-server",
				label: "s1",
				credential: "inline-with-companion",
				extras: { declared: true, expectedFailures: true },
			},
			{ kind: "redeclare-server", label: "s1" },
			{ kind: "chat", verb: "think", a: 5, b: 0, pick: 671 },
			{ kind: "set-secret", label: "s1", field: "apiKey", serial: 6 },
		],
	},
];
