/**
 * Corpus of monkey walks that once failed the interaction fuzzer. Entries
 * replay at the start of every docker-monkey run, before the random walks,
 * so a bug found by a nightly seed stays found after the generator changes.
 *
 * To add an entry: take the "minimal failing corpus entry" JSON from the
 * failure report (the fuzzer shrinks failing walks automatically) and append
 * it here with a name referencing the issue. Labels inside actions are
 * abstract tokens; the executor mints fresh monkey-<seed>-<run>- labels on
 * every replay, so entries never collide with the host's add-only groups.
 */

import type { MonkeyCorpusEntry } from "./monkeyFuzz";

export const MONKEY_CORPUS: MonkeyCorpusEntry[] = [
	{
		// FUZZ_SEED=1 walk 0, shrunk: the OAuth declare's forced sync pass added
		// the group and persisted its fingerprint, but the debounced follow-up
		// pass re-read a stale (pre-add) fingerprint map from globalState,
		// re-added the group, and misclassified the duplicate rejection as a
		// permanent foreign name conflict. Fixed by making the sync engine's
		// in-memory fingerprint map the session truth; the chat stays in the
		// trace because the failure was timing-dependent (the shrinker kept it).
		name: "oauth-declare-lost-fingerprint-update",
		actions: [
			{ kind: "chat", verb: "stream", a: 4, b: 0, pick: 633 },
			{ kind: "declare-server", label: "s2", credential: "oauth" },
		],
	},
	{
		// FUZZ_SEED=575380 walk 0 (CI run 30684907448), re-expanded from the
		// shrunk single bad-key declare: the group-removal feature tombstones an
		// explicitly removed entry's provider group, so its models leave the
		// host list, while the oracle's model-count floors kept counting every
		// healthy ever-synced group forever. The prior run's cleanup removals
		// poisoned the floors and every later walk failed its first probe. The
		// oracle now moves removed labels to the hidden side of the floors;
		// this trace replays the whole chain: a healthy fake group, its
		// explicit removal (tombstoned and hidden), then another declare whose
		// probes must accept the hidden group's absence.
		name: "removed-entry-tombstone-hides-healthy-group",
		actions: [
			{ kind: "declare-server", label: "s1", credential: "oauth" },
			{ kind: "remove-server", label: "s1" },
			{ kind: "declare-server", label: "s2", credential: "bad-key" },
		],
	},
	{
		// FUZZ_SEED=466017 walk 21, shrunk (nightly run 30692494781, #220): the
		// remove's sync pass resolved the removed label's base URL from a fresh
		// globalState ledger read that had reverted to a pre-declare version,
		// so the removal event carried no URL, no tombstone was written, and
		// the removed group's models never left the host list. All three
		// nightly shards hit the same class mid-session (the tombstone store's
		// own read-modify-write lost entries the same way during multi-label
		// cleanups). Fixed by making the engine's session ledger and the
		// removal store's session caches the truth, like the fingerprint map;
		// the failure was storage-timing-dependent, so this trace guards the
		// sequence rather than deterministically reproducing the revert (the
		// unit suites pin the revert itself with simulated stale reads).
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
			{ kind: "set-headers", valid: true, serial: 11 },
			{ kind: "set-model-parameters", valid: true, serial: 12 },
		],
	},
];
