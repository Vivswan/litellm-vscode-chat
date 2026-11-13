import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_TOOLS, SKILL_NAME } from "../../shared/config/commandIds";
import { AGENT_TOOL_TOGGLE_KEYS, CONFIG_SECTION, FEATURE_ENABLE_SETTING_KEYS } from "../../shared/config/settingSpec";
import { REPO_ROOT } from "../util/repoRoot";

/**
 * The skill is prose an agent follows and nothing compiles it, so a renamed tool or setting would leave /litellm
 * sending agents to a name the extension no longer has.
 */
describe("the /litellm skill", () => {
	const skill = readFileSync(path.join(REPO_ROOT, "skills", SKILL_NAME, "SKILL.md"), "utf8");
	const named = (pattern: RegExp): string[] => [...new Set(skill.match(pattern))].sort();

	test("names every agent tool, and no tool the extension does not contribute", () => {
		const tools = Object.values(AGENT_TOOLS).map((tool) => tool.name);
		expect(named(/\blitellm_[a-z_]+/g)).toEqual(tools.sort());
	});

	test("names the read switch and each write tool's own switch, and no setting that does not exist", () => {
		const switches = [FEATURE_ENABLE_SETTING_KEYS.agentTools, ...Object.values(AGENT_TOOL_TOGGLE_KEYS)];
		expect(named(/litellm-vscode-chat\.[A-Za-z.]*[A-Za-z]/g)).toEqual(
			switches.map((key) => `${CONFIG_SECTION}.${key}`).sort()
		);
	});

	test("names the dashboard command by the title the command palette shows", () => {
		const nls: Record<string, string> = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.nls.json"), "utf8"));
		expect(skill).toContain(`\`${nls["litellm.command.openDashboard.title"]}\``);
	});
});
