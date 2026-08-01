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
];
