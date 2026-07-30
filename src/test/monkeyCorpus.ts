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

export const MONKEY_CORPUS: MonkeyCorpusEntry[] = [];
