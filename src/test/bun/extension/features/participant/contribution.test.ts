/**
 * The chatParticipants contribution, pinned where the manifest alone decides
 * behavior no runtime test can reach: the host reads these fields long before
 * activation, so a wrong `name` pattern, a command the registry never answers,
 * or an empty disambiguation entry ships silently green.
 *
 * The disambiguation checks are deliberately shape-and-substance guards rather
 * than prose review: they cannot judge whether a category routes well, but
 * they can refuse the failure modes that make routing impossible - a missing
 * category, a description too short to define an intent, or examples that are
 * keywords instead of the sentences the classifier is shown.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { builtinSlashCommands } from "../../../../../extension/features/participant/slashCommands";
import { PARTICIPANT_ID } from "../../../../../shared/config/commandIds";
import { CONFIG_SECTION, FEATURE_ENABLE_SETTING_KEYS } from "../../../../../shared/config/settingSpec";
import { REPO_ROOT } from "../../../../util/repoRoot";

interface Disambiguation {
	readonly category?: string;
	readonly description?: string;
	readonly examples?: readonly string[];
}

interface ContributedCommand {
	readonly name?: string;
	readonly description?: string;
	readonly isSticky?: boolean;
	readonly sampleRequest?: string;
	readonly disambiguation?: readonly Disambiguation[];
}

interface ContributedParticipant {
	readonly id?: string;
	readonly name?: string;
	readonly fullName?: string;
	readonly description?: string;
	readonly isSticky?: boolean;
	readonly sampleRequest?: string;
	readonly when?: string;
	readonly disambiguation?: readonly Disambiguation[];
	readonly commands?: readonly ContributedCommand[];
}

function readManifest(): { chatParticipants?: readonly ContributedParticipant[] } {
	const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
		contributes: { chatParticipants?: readonly ContributedParticipant[] };
	};
	return manifest.contributes;
}

function participant(): ContributedParticipant {
	const [only] = readManifest().chatParticipants ?? [];
	expect(only, "package.json contributes no chat participant").toBeDefined();
	return only as ContributedParticipant;
}

/** Every nls table, so a %key% reference can be resolved in each locale that ships. */
function nlsTables(): { locale: string; table: Record<string, string> }[] {
	return ["", "zh-cn", "zh-tw"].map((locale) => ({
		locale: locale === "" ? "en" : locale,
		table: JSON.parse(
			readFileSync(path.join(REPO_ROOT, locale === "" ? "package.nls.json" : `package.nls.${locale}.json`), "utf8")
		) as Record<string, string>,
	}));
}

/**
 * A manifest string in every locale: a "%key%" through each nls table, a
 * literal as itself. English comes first, and is the locale the length checks
 * judge - a character count is not a language-fair measure of substance (the
 * same request is roughly a third as many characters in Chinese), so only the
 * reference wording is measured and every other locale must merely be there
 * and non-empty.
 */
function localizedValues(value: string | undefined): { locale: string; text: string }[] {
	expect(value, "a localized manifest field is missing").toBeDefined();
	const match = /^%([\w.]+)%$/.exec(value ?? "");
	if (match === null) {
		return [{ locale: "en", text: value as string }];
	}
	return nlsTables().map(({ locale, table }) => {
		const resolved = table[match[1] as string];
		expect(resolved, `package.nls.${locale} has no entry for ${value}`).toBeDefined();
		return { locale, text: resolved as string };
	});
}

/** The English wording of a manifest string: the one the length checks judge. */
function englishValue(value: string | undefined): string {
	const [english] = localizedValues(value);
	expect(english?.locale).toBe("en");
	return english?.text as string;
}

/**
 * A disambiguation block is usable when every entry names a category, defines
 * the intent in a real sentence, and shows the classifier example REQUESTS.
 */
function expectUsableDisambiguation(entries: readonly Disambiguation[] | undefined, where: string): void {
	expect(entries, `${where} contributes no disambiguation`).toBeDefined();
	expect((entries ?? []).length, `${where} contributes an empty disambiguation array`).toBeGreaterThan(0);
	for (const entry of entries ?? []) {
		// Machine-readable and stable, so deliberately NOT localized.
		expect(entry.category, `${where} has a disambiguation entry with no category`).toMatch(/^[a-z][a-z0-9_]+$/);
		for (const { locale, text } of localizedValues(entry.description)) {
			expect(text.trim(), `${where}/${entry.category} description is empty in ${locale}`).not.toBe("");
		}
		expect(
			englishValue(entry.description).length,
			`${where}/${entry.category} description is too short to define an intent`
		).toBeGreaterThan(40);
		expect((entry.examples ?? []).length, `${where}/${entry.category} shows no examples`).toBeGreaterThan(1);
		for (const example of entry.examples ?? []) {
			for (const { locale, text } of localizedValues(example)) {
				expect(text.trim(), `${where}/${entry.category} example is empty in ${locale}`).not.toBe("");
			}
			// Examples are the requests a user would actually type; a keyword or a
			// label teaches the classifier nothing.
			expect(
				englishValue(example).length,
				`${where}/${entry.category} example is not a request: ${englishValue(example)}`
			).toBeGreaterThan(15);
		}
	}
}

/**
 * The host's schema for these two objects is additionalProperties:false, so an
 * unknown key is not "extra metadata" - it makes VS Code reject the whole
 * contribution, and the extension then has no participant at all. A hand-written
 * interface cast cannot catch that (excess keys survive a cast), so the allowed
 * key sets are restated here as data and checked against what the file holds.
 */
const PARTICIPANT_KEYS = new Set([
	"id",
	"name",
	"fullName",
	"description",
	"isSticky",
	"sampleRequest",
	"when",
	"disambiguation",
	"commands",
]);
const COMMAND_KEYS = new Set(["name", "description", "when", "sampleRequest", "isSticky", "disambiguation"]);
const DISAMBIGUATION_KEYS = new Set(["category", "description", "examples"]);

describe("extension/features/participant contribution", () => {
	test("exactly one participant, under the shared id, with a host-legal name", () => {
		const participants = readManifest().chatParticipants ?? [];
		expect(participants.length).toBe(1);
		expect(participants[0]?.id).toBe(PARTICIPANT_ID);
		// The host's own pattern for the @-invoked name.
		expect(participants[0]?.name).toMatch(/^[\w-]+$/);
		expect(participants[0]?.fullName?.trim()).not.toBe("");
	});

	test("the participant carries the fields the chat UI shows", () => {
		const entry = participant();
		expect(entry.isSticky).toBe(true);
		for (const { locale, text } of localizedValues(entry.description)) {
			expect(text.trim(), `the participant description is empty in ${locale}`).not.toBe("");
		}
		for (const { locale, text } of localizedValues(entry.sampleRequest)) {
			expect(text.trim(), `the participant sample request is empty in ${locale}`).not.toBe("");
		}
	});

	test("the contributed commands are exactly the built-in table, in the same order", () => {
		// Order too, not just the set: the manifest drives the "/" picker and the
		// registry drives the in-chat help listing, and a user reading both
		// should not have to reconcile two orders.
		const contributed = (participant().commands ?? []).map((command) => command.name);
		expect(contributed).toEqual(builtinSlashCommands().map((command) => command.name));
	});

	test("every contributed command carries a description and a sample request in every locale", () => {
		for (const command of participant().commands ?? []) {
			for (const { locale, text } of localizedValues(command.description)) {
				expect(text.trim(), `/${command.name} description is empty in ${locale}`).not.toBe("");
			}
			for (const { locale, text } of localizedValues(command.sampleRequest)) {
				expect(text.trim(), `/${command.name} sample request is empty in ${locale}`).not.toBe("");
			}
		}
	});

	test("the manifest and the registry tell the user the same thing about each command", () => {
		// Two runtimes, two string tables (the host reads package.nls before this
		// process exists), so the prose cannot be shared by construction - but it
		// can be pinned equal, which is what keeps the "/" picker and the in-chat
		// listing from describing the same command two ways.
		const builtin = new Map(builtinSlashCommands().map((command) => [command.name, command.description]));
		for (const command of participant().commands ?? []) {
			const registryDescription = builtin.get(command.name as string);
			expect(
				registryDescription,
				`/${command.name} is contributed but the registry answers no such command`
			).toBeDefined();
			expect(englishValue(command.description), `/${command.name}: manifest and registry descriptions differ`).toBe(
				registryDescription as string
			);
		}
	});

	test("the participant and each command carry usable disambiguation", () => {
		expectUsableDisambiguation(participant().disambiguation, "participant");
		for (const command of participant().commands ?? []) {
			expectUsableDisambiguation(command.disambiguation, `/${command.name}`);
		}
	});

	test("no key outside the host's allowlist: additionalProperties is false on every level", () => {
		const entry = participant() as unknown as Record<string, unknown>;
		expect([...Object.keys(entry)].filter((key) => !PARTICIPANT_KEYS.has(key))).toEqual([]);
		for (const command of (participant().commands ?? []) as unknown as Record<string, unknown>[]) {
			expect(
				[...Object.keys(command)].filter((key) => !COMMAND_KEYS.has(key)),
				`/${String(command.name)} carries a key the host schema forbids`
			).toEqual([]);
		}
		const blocks = [
			...(participant().disambiguation ?? []),
			...(participant().commands ?? []).flatMap((command) => command.disambiguation ?? []),
		] as unknown as Record<string, unknown>[];
		expect(blocks.length).toBeGreaterThan(0);
		for (const block of blocks) {
			expect([...Object.keys(block)].filter((key) => !DISAMBIGUATION_KEYS.has(key))).toEqual([]);
		}
	});

	test("the participant is gated on its own enable setting, so disabling it also hides it", () => {
		// Disposing the runtime participant is only half of "off": without this
		// when-clause the host keeps offering @litellm in the picker and routes
		// to a participant that no longer has a handler.
		expect(participant().when).toBe(`config.${CONFIG_SECTION}.${FEATURE_ENABLE_SETTING_KEYS.chatParticipant}`);
	});

	test("every disambiguation category is unique across the whole contribution", () => {
		// Categories are the classifier's intent ids; two blocks sharing one is a
		// routing ambiguity of our own making.
		const entry = participant();
		const categories = [
			...(entry.disambiguation ?? []),
			...(entry.commands ?? []).flatMap((command) => command.disambiguation ?? []),
		].map((block) => block.category);
		expect(new Set(categories).size).toBe(categories.length);
	});
});
