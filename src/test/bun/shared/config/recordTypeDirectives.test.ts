/**
 * The completeness pin on RECORD_TYPE_DIRECTIVES, the one mint of every
 * type-specific directive name. The sibling wrong-type sets derive from it by
 * construction; this suite closes what a derivation cannot prove: the rows
 * stay disjoint (from each other and the shared engine directives), every
 * registered name is really handled by its own parser rather than sitting
 * stale, and every parser flags exactly the sibling names - nothing more. The
 * parser map is total over RecordType, so minting a third record type fails
 * this file's typecheck until its parser is wired in, and the loops then hold
 * it to the same mutual-flagging contract.
 *
 * The literal sweeps below close the remaining hole - a directive a module
 * HANDLES but nobody registered, or a name UI copy still spells after a
 * rename. The source sweep scans CODE, through an AST walk over the string
 * literals and the identifier-spelled property routes of every module in
 * src/shared/config, so comments and doc prose never count (a message string
 * would, but these diagnostics carry kinds and keys, never prose). What it
 * still misses: a name built at runtime, and identifier forms no directive
 * has ever taken (class members, enum members).
 * The copy sweep scans every l10n bundle's and package.nls file's keys and
 * translated values for directive-shaped tokens, so localized copy cannot
 * keep teaching a name the registry dropped. The docs sweep holds every
 * markdown file under docs/ (translations included), the README files
 * (the Marketplace landing page), and AGENTS.md to the same token grammar.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { DECLARE_DIRECTIVE } from "../../../../extension/migrations/settingsRedesign/legacyIds";
import { parseCapabilityRecord } from "../../../../shared/config/capabilityResolution";
import { parseParameterRecord } from "../../../../shared/config/parameterResolution";
import type { ParsedRecord, RecordType } from "../../../../shared/config/recordResolution";
import {
	INHERIT_FROM_DIRECTIVE,
	INHERITABLE_DIRECTIVE,
	OPENROUTER_MODEL_DIRECTIVE,
	RECORD_TYPE_DIRECTIVES,
} from "../../../../shared/config/recordResolution";
import { isRecord, isUnsafeRecordKey } from "../../../../shared/util/json";
import { REPO_ROOT } from "../../../util/repoRoot";

/** Total over RecordType on purpose: a registry row without a parser fails typecheck here. */
const PARSERS: Readonly<Record<RecordType, (record: Readonly<Record<string, unknown>>) => ParsedRecord>> = {
	parameters: parseParameterRecord,
	capabilities: (record) => parseCapabilityRecord(record),
};

const RECORD_TYPES = Object.keys(RECORD_TYPE_DIRECTIVES) as readonly RecordType[];
const SHARED_DIRECTIVES: ReadonlySet<string> = new Set([INHERITABLE_DIRECTIVE, INHERIT_FROM_DIRECTIVE]);

/** The full registered vocabulary: every type-specific row plus the shared engine directives. */
const REGISTERED_DIRECTIVES: ReadonlySet<string> = new Set([
	...RECORD_TYPES.flatMap((type) => [...RECORD_TYPE_DIRECTIVES[type]]),
	...SHARED_DIRECTIVES,
]);

/**
 * Every module in shared/config, found by directory listing rather than
 * hand-listed, so a new one joins the sweep by existing. The whole tree is in
 * scope because directive consumers are not only the parsers: the mint site
 * (recordResolution.ts) carries the literals of directives handled through
 * imported constants, and any config module may branch on a directive name.
 */
const CONFIG_DIR = path.join(REPO_ROOT, "src", "shared", "config");
const SCANNED_SOURCES: readonly string[] = fs
	.readdirSync(CONFIG_DIR)
	.filter((name) => name.endsWith(".ts"))
	.sort();

/** The modules the sweep must reach: it may grow past them, never shrink below them. */
const REQUIRED_SOURCES: readonly string[] = [
	"capabilityDisplay.ts",
	"capabilityResolution.ts",
	"commandIds.ts",
	"modelMatcher.ts",
	"openRouterCatalog.ts",
	"parameterResolution.ts",
	"recordResolution.ts",
	"resolutionTable.ts",
	"settingSpec.ts",
	"settings.ts",
	"storageKeys.ts",
];

/**
 * Every underscore-prefixed name the file's code spells: string and template
 * literals, plus the identifier routes a literal walk is blind to - property
 * access (`record._force`), object-literal and type-member keys, and
 * destructuring bindings. The remaining blind spot is a name built at runtime.
 * The one-char "_" is the namespace probe, never a name. Reserved
 * object-plumbing names ("__proto__") are exempt by the same predicate the
 * record grammar enforces: isUnsafeRecordKey rejects them as record keys, so
 * no such name could ever be a directive. No such literal exists in code today
 * (the tree's are all in comments); the carve-out pre-empts the next hardening
 * one rather than excusing an existing one.
 */
function underscoreNames(fileName: string): ReadonlySet<string> {
	const text = fs.readFileSync(path.join(CONFIG_DIR, fileName), "utf8");
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found = new Set<string>();
	const collect = (name: string): void => {
		if (/^_./.test(name) && !isUnsafeRecordKey(name)) {
			found.add(name);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
			collect(node.text);
		} else if (ts.isPropertyAccessExpression(node)) {
			collect(node.name.text);
		} else if (
			(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node)) &&
			ts.isIdentifier(node.name)
		) {
			collect(node.name.text);
		} else if (ts.isBindingElement(node)) {
			const key = node.propertyName ?? node.name;
			if (ts.isIdentifier(key)) {
				collect(key.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/**
 * One token grammar for every prose sweep (localized copy and docs alike). The
 * boundary class includes "_" so the inner slice of a dunder name never counts
 * ("__proto__" would otherwise yield the phantom token "_proto__"). Callers use
 * String.match, which a global regex's lastIndex cannot skew; test/exec would.
 */
const DIRECTIVE_TOKEN_PATTERN = /(?<![A-Za-z0-9_])_[a-z][a-z0-9_]*/g;

/** One parse per file, shared by the sweep and its positive control. */
const NAMES_BY_FILE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	SCANNED_SOURCES.map((file) => [file, underscoreNames(file)])
);

describe("shared/config record-type directive registry", () => {
	test("every name is underscore-prefixed and minted in exactly one row, never a shared engine directive", () => {
		const seen = new Map<string, RecordType>();
		for (const type of RECORD_TYPES) {
			for (const name of RECORD_TYPE_DIRECTIVES[type]) {
				assert.ok(name.startsWith("_"), `${name} is not underscore-prefixed`);
				assert.ok(!SHARED_DIRECTIVES.has(name), `${name} collides with a shared engine directive`);
				assert.strictEqual(seen.get(name), undefined, `${name} is minted in two rows`);
				seen.set(name, type);
			}
		}
	});

	test("each registered directive is live in its own parser and wrong-record-type in every sibling", () => {
		for (const type of RECORD_TYPES) {
			for (const name of RECORD_TYPE_DIRECTIVES[type]) {
				// 12345 is a valid value for no known directive, so a handled name
				// must answer with some diagnostic; an unhandled one would parse
				// silently (the forward-compat rule) and mean a stale registry row.
				const own = PARSERS[type]({ [name]: 12345 });
				assert.ok(own.diagnostics.length > 0, `${type} parser silently ignores its own ${name}`);
				assert.ok(
					own.diagnostics.every((diagnostic) => diagnostic.kind !== "wrong-record-type"),
					`${type} parser flags its own ${name} as the wrong record type`
				);
				for (const sibling of RECORD_TYPES.filter((other) => other !== type)) {
					assert.deepStrictEqual(
						PARSERS[sibling]({ [name]: 12345 }).diagnostics,
						[{ kind: "wrong-record-type", key: name }],
						`${sibling} parser does not flag ${name} as exactly one wrong-record-type`
					);
				}
			}
		}
	});

	test("no parser flags beyond the sibling rows: shared directives and unknown underscore keys pass", () => {
		for (const type of RECORD_TYPES) {
			for (const name of SHARED_DIRECTIVES) {
				assert.ok(
					PARSERS[type]({ [name]: false }).diagnostics.every((diagnostic) => diagnostic.kind !== "wrong-record-type"),
					`${type} parser flags shared ${name} as the wrong record type`
				);
			}
			assert.deepStrictEqual(PARSERS[type]({ _future_directive: 12345 }).diagnostics, []);
		}
	});

	test("every underscore name the shared/config sources spell is a registered directive", () => {
		const failures: string[] = [];
		for (const [file, names] of NAMES_BY_FILE) {
			for (const name of names) {
				if (!REGISTERED_DIRECTIVES.has(name)) {
					failures.push(
						`src/shared/config/${file} carries the unregistered underscore name "${name}": ` +
							"add it to RECORD_TYPE_DIRECTIVES or the shared engine directives in recordResolution.ts"
					);
				}
			}
		}
		assert.deepStrictEqual(failures, []);
	});

	test("every directive-shaped token in the localized copy is a registered directive", () => {
		// UI copy necessarily spells directive names inside localized literals
		// (extraction needs whole sentences), so a registry rename would leave
		// those messages teaching a gone name. Fail closed over every l10n
		// bundle's and package.nls file's keys AND translated values -
		// translations keep directive tokens verbatim - so neither the source
		// copy nor a locale can drift stale.
		const l10nDir = path.join(REPO_ROOT, "l10n");
		const copyFiles = [
			...fs
				.readdirSync(l10nDir)
				.filter((name) => name.startsWith("bundle.l10n") && name.endsWith(".json"))
				.map((name) => path.join("l10n", name)),
			...fs.readdirSync(REPO_ROOT).filter((name) => name.startsWith("package.nls") && name.endsWith(".json")),
		].sort();
		const found = new Set<string>();
		const failures: string[] = [];
		for (const file of copyFiles) {
			const bundle = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")) as Record<string, unknown>;
			for (const [key, value] of Object.entries(bundle)) {
				const message =
					typeof value === "string" ? value : isRecord(value) && typeof value.message === "string" ? value.message : "";
				for (const text of [key, message]) {
					for (const token of text.match(DIRECTIVE_TOKEN_PATTERN) ?? []) {
						found.add(token);
						if (!REGISTERED_DIRECTIVES.has(token)) {
							failures.push(
								`${file} entry "${key}" spells "${token}", which is no registered directive: ` +
									"rename the copy wherever it is minted, re-run l10n:extract, and retranslate"
							);
						}
					}
				}
			}
		}
		assert.deepStrictEqual(failures, []);
		// Positive controls: the source bundle, the settings-UI nls file, and
		// their translations must all be in the sweep; the modelInspector suite
		// pins rendered messages that spell _inherit_from, and _inheritable is
		// spelled only in the nls files, so a sweep that stops seeing either is
		// a broken or narrowed walk.
		assert.ok(
			copyFiles.includes(path.join("l10n", "bundle.l10n.json")),
			"the sweep no longer reaches the source bundle"
		);
		assert.ok(copyFiles.includes("package.nls.json"), "the sweep no longer reaches the settings-UI copy");
		assert.ok(copyFiles.length >= 6, "the sweep no longer reaches the translated copies");
		assert.ok(found.has(INHERIT_FROM_DIRECTIVE), "the copy sweep no longer sees _inherit_from's spelling");
		assert.ok(found.has(INHERITABLE_DIRECTIVE), "the copy sweep no longer sees _inheritable's spelling");
	});

	test("every directive-shaped token in the docs, README, and AGENTS.md files is a registered directive", () => {
		// The docs teach the record grammar in prose and code fences, so
		// registered spellings are expected and pass; the sweep detects renames,
		// where a dropped registry name would leave the docs teaching it.
		const docsDir = path.join(REPO_ROOT, "docs");
		// Separators normalized so the reach pins and messages read the same on every OS.
		const docFiles = fs
			.readdirSync(docsDir, { recursive: true, encoding: "utf8" })
			.filter((name) => name.endsWith(".md"))
			.map((name) => `docs/${name.replaceAll("\\", "/")}`)
			.sort();
		// The README files spell directives in Marketplace-facing prose (the
		// privacy paragraph names _openrouter_model). CHANGELOG.md stays out
		// deliberately: its historical release notes correctly keep retired names.
		const readmeFiles: ReadonlySet<string> = new Set(
			fs.readdirSync(REPO_ROOT).filter((name) => name.startsWith("README") && name.endsWith(".md"))
		);
		// AGENTS.md joins by name, never a root *.md glob: CLAUDE.md and the two
		// .github agent files are symlinks to it (a glob would sweep the same
		// bytes repeatedly), and CHANGELOG.md must stay excluded as above.
		const AGENTS_FILE = "AGENTS.md";
		const sweptFiles = [...docFiles, ...readmeFiles, AGENTS_FILE].sort();
		// Non-directive tokens the docs legitimately spell, each pinned below so
		// a dropped mention retires its entry. DECLARE_DIRECTIVE is the retired
		// name the migration docs teach, imported from the migration's own
		// quarantine so retiring the migration breaks this line with it;
		// _reasoning_effort is the tail of the capability flag
		// supports_<level>_reasoning_effort, split off by the <level> placeholder.
		const allowedTokens: ReadonlySet<string> = new Set([DECLARE_DIRECTIVE, "_reasoning_effort"]);
		// Per-leg token sets, so the docs completeness pins below keep their
		// original claim (documented in docs/, not merely mentioned in a README).
		const docsFound = new Set<string>();
		const readmeFound = new Set<string>();
		const agentsFound = new Set<string>();
		const failures: string[] = [];
		for (const file of sweptFiles) {
			const legFound = readmeFiles.has(file) ? readmeFound : file === AGENTS_FILE ? agentsFound : docsFound;
			const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
			for (const token of new Set(text.match(DIRECTIVE_TOKEN_PATTERN) ?? [])) {
				legFound.add(token);
				if (!REGISTERED_DIRECTIVES.has(token) && !allowedTokens.has(token)) {
					failures.push(
						`${file} spells "${token}", which is no registered directive: ` +
							"update the docs (source and translations), or justify a genuine non-directive token in the allowlist"
					);
				}
			}
		}
		assert.deepStrictEqual(failures, []);
		// Positive controls: the walk must reach the source docs, both
		// translation trees, and every README, and must still see every
		// registered directive's spelling - a narrowed walk or dead pattern
		// fails here, not silently.
		assert.ok(docFiles.length >= 24, "the docs sweep no longer reaches the full docs tree");
		for (const file of ["docs/models.md", "docs/zh-cn/models.md", "docs/zh-tw/models.md"]) {
			assert.ok(docFiles.includes(file), `the docs sweep no longer reaches ${file}`);
		}
		for (const file of ["README.md", "README.zh-cn.md", "README.zh-tw.md"]) {
			assert.ok(readmeFiles.has(file), `the sweep no longer reaches ${file}`);
		}
		assert.ok(
			readmeFound.has(OPENROUTER_MODEL_DIRECTIVE),
			"the README files no longer spell _openrouter_model: point this control at a token they do spell"
		);
		for (const name of REGISTERED_DIRECTIVES) {
			assert.ok(docsFound.has(name), `${name} is spelled nowhere in docs/: document it, or the walk narrowed`);
			assert.ok(agentsFound.has(name), `${name} is spelled nowhere in AGENTS.md: teach it there, or the walk narrowed`);
		}
		for (const token of allowedTokens) {
			assert.ok(!REGISTERED_DIRECTIVES.has(token), `${token} is registered now: retire its allowlist entry`);
			assert.ok(docsFound.has(token), `the docs no longer spell ${token}: retire its allowlist entry`);
		}
	});

	test("the sweep reaches every config module and sees every registered mint (its positive control)", () => {
		// Two ways this guard could pass while proving nothing: scanning fewer
		// files than it claims, or a walk that silently collects nothing.
		for (const file of REQUIRED_SOURCES) {
			assert.ok(SCANNED_SOURCES.includes(file), `the sweep no longer reaches ${file}`);
		}
		const found = new Set<string>([...NAMES_BY_FILE.values()].flatMap((names) => [...names]));
		for (const name of REGISTERED_DIRECTIVES) {
			assert.ok(found.has(name), `the sweep no longer sees ${name}'s mint in the scanned sources`);
		}
	});
});
