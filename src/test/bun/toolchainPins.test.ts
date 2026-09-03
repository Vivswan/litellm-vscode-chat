import { describe, test } from "bun:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "../util/repoRoot";

/**
 * The template-managed `.bun-version` is the one bun pin; every mirror of it -
 * the workflows' setup-bun steps, package.json's packageManager, the @types/bun
 * stubs, compose's oven/bun image, the devcontainer's bun feature, and the bun
 * running this suite - must agree, or local, CI, and the fake stack transpile
 * the same source differently.
 */

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface WorkflowStep {
	uses?: unknown;
	with?: Record<string, unknown>;
}

function read(relative: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function majorMinor(version: string): string {
	const match = RELEASE.exec(version);
	assert.ok(match, `"${version}" is not an exact major.minor.patch release`);
	return `${match[1]}.${match[2]}`;
}

/** Every setup-bun step of a workflow, with the file and job that own it. */
function setupBunSteps(file: string): { at: string; step: WorkflowStep }[] {
	const workflow = Bun.YAML.parse(read(`.github/workflows/${file}`)) as {
		jobs?: Record<string, { steps?: WorkflowStep[] }>;
	};
	const found: { at: string; step: WorkflowStep }[] = [];
	for (const [job, { steps }] of Object.entries(workflow.jobs ?? {})) {
		for (const [index, step] of (steps ?? []).entries()) {
			if (typeof step.uses === "string" && step.uses.startsWith("oven-sh/setup-bun@")) {
				found.push({ at: `.github/workflows/${file} jobs.${job}.steps[${index}]`, step });
			}
		}
	}
	return found;
}

describe("toolchain pins", () => {
	const pinned = read(".bun-version").trim();

	test(".bun-version is an exact release", () => {
		assert.match(pinned, RELEASE, `.bun-version must pin an exact bun release, got "${pinned}"`);
	});

	test("the running bun, packageManager, @types/bun, compose, the devcontainer, and every setup-bun step name the .bun-version release", () => {
		const pkg = JSON.parse(read("package.json")) as {
			packageManager?: string;
			devDependencies: Record<string, string>;
		};
		const installedTypes = JSON.parse(read("node_modules/@types/bun/package.json")) as { version: string };
		const declaredTypes = pkg.devDependencies["@types/bun"] ?? "";
		const packageManager = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "")?.[1] ?? pkg.packageManager;

		const disagreements: string[] = [];
		if (Bun.version !== pinned) {
			disagreements.push(`running bun: ${Bun.version} (want ${pinned})`);
		}
		if (packageManager !== pinned) {
			disagreements.push(`package.json packageManager: "${pkg.packageManager}" (want "bun@${pinned}")`);
		}
		// @types/bun releases follow bun's major.minor; a patch offset is a stub release, not a toolchain change.
		if (!RELEASE.test(declaredTypes) || majorMinor(declaredTypes) !== majorMinor(pinned)) {
			disagreements.push(`package.json devDependencies @types/bun: "${declaredTypes}" (want ${majorMinor(pinned)}.x)`);
		}
		if (majorMinor(installedTypes.version) !== majorMinor(pinned)) {
			disagreements.push(
				`node_modules/@types/bun: "${installedTypes.version}" (want ${majorMinor(pinned)}.x; run bun install)`
			);
		}

		const image = /^\s+image: docker\.io\/oven\/bun:(\S+?)-alpine$/m.exec(read("docker/docker-compose.yml"))?.[1];
		assert.ok(image, "docker/docker-compose.yml runs the fake backend on a docker.io/oven/bun:*-alpine image");
		if (image !== pinned) {
			disagreements.push(`docker/docker-compose.yml oven/bun image: "${image}-alpine" (want "${pinned}-alpine")`);
		}
		// devcontainer.json is JSONC; drop full-line comments before parsing.
		const { features } = JSON.parse(read(".devcontainer/devcontainer.json").replace(/^\s*\/\/.*$/gm, "")) as {
			features?: Record<string, { version?: string }>;
		};
		const bunFeature = Object.entries(features ?? {}).find(([id]) => /\/bun:\d+$/.test(id));
		assert.ok(bunFeature, ".devcontainer/devcontainer.json declares a bun feature");
		if (bunFeature[1].version !== pinned) {
			disagreements.push(
				`.devcontainer/devcontainer.json ${bunFeature[0]} version: "${bunFeature[1].version}" (want "${pinned}")`
			);
		}

		const workflows = fs.readdirSync(path.join(REPO_ROOT, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file));
		const steps = workflows.sort().flatMap(setupBunSteps);
		assert.ok(steps.length > 0, "no setup-bun step found under .github/workflows");
		for (const { at, step } of steps) {
			const inputs = Object.entries(step.with ?? {}).filter(([key]) => key.startsWith("bun-version"));
			const [only] = inputs;
			if (inputs.length !== 1 || only?.[0] !== "bun-version-file" || only[1] !== ".bun-version") {
				const shown =
					inputs.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ") || "(no version input)";
				disagreements.push(`${at}: ${shown} (want bun-version-file: .bun-version)`);
			}
		}

		assert.deepStrictEqual(disagreements, [], `bun pins disagree with .bun-version (${pinned})`);
	});
});
