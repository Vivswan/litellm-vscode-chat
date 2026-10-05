/**
 * Negative control for the model-facing exit rules of scripts/ci/output-channel-writes.ts: every construct and return
 * shape the scanner must refuse beside the look-alikes it must ignore. Never imported; the test names sanctionedResult
 * and sanctionedPrepared as this file's exit functions and reads one tag per judgment on the line.
 *
 *   refused@7 construct { invocationMessage }  -> verdict, 1-based column, rule, shape, as the scanner reports it
 *   allowed@10 return return in invoke        -> judged and accepted
 *   tag | tag                                 -> a line judged twice (a return whose value is a construct)
 *   a tag line alone                          -> the code line above it (the formatter moves a tag off an opening `{`)
 *   untagged                                  -> no judgment lands on this line (a member whose body is judged elsewhere)
 */
import * as vscode from "vscode";
import { ImportedTool } from "./modelFacingHelperFixture";

declare const raw: string;
declare const forwarded: vscode.LanguageModelToolResult;
declare const forwardOptions: vscode.LanguageModelToolInvocationOptions<object>;
declare function exitNever(): Promise<never>;

export function sanctionedResult(text: string): vscode.LanguageModelToolResult {
	const part = new vscode.LanguageModelTextPart(text); // allowed@15 construct new LanguageModelTextPart
	return new vscode.LanguageModelToolResult([part]); // allowed@9 construct new LanguageModelToolResult
}

export function sanctionedPrepared(message: string): vscode.PreparedToolInvocation {
	return { invocationMessage: message }; // allowed@9 construct { invocationMessage }
}

export function unlisted(): vscode.PreparedToolInvocation {
	new vscode.LanguageModelToolResult([]); // refused@2 construct new LanguageModelToolResult
	new vscode.LanguageModelTextPart(raw); // refused@2 construct new LanguageModelTextPart
	new vscode.LanguageModelPromptTsxPart({}); // refused@2 construct new LanguageModelPromptTsxPart
	new vscode.LanguageModelDataPart(new Uint8Array(), "text/plain"); // refused@2 construct new LanguageModelDataPart
	vscode.LanguageModelDataPart.text(raw); // refused@2 construct LanguageModelDataPart.text
	vscode.LanguageModelDataPart.json({}); // refused@2 construct LanguageModelDataPart.json
	const Part = vscode.LanguageModelTextPart;
	new Part(raw); // refused@2 construct new LanguageModelTextPart
	const text = vscode.LanguageModelDataPart.text;
	text(raw); // refused@2 construct LanguageModelDataPart.text
	void { invocationMessage: raw }; // refused@7 construct { invocationMessage }
	void { confirmationMessages: { title: raw, message: raw } }; // refused@7 construct { confirmationMessages }
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key literal shape
	void { ["invocationMessage"]: raw }; // refused@7 construct { invocationMessage }
	const key = "invocationMessage";
	void { [key]: raw }; // refused@7 construct { invocationMessage }
	new vscode.MarkdownString(raw);
	new Set<string>();
	void { value: raw };
	return { invocationMessage: raw, confirmationMessages: { title: raw, message: raw } }; // refused@9 construct { invocationMessage, confirmationMessages }
}

export class DirectTool implements vscode.LanguageModelTool<unknown> {
	prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: raw }; // refused@10 construct { invocationMessage } | allowed@10 return return in prepareInvocation
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		return new vscode.LanguageModelToolResult([]); // refused@10 construct new LanguageModelToolResult | allowed@10 return return in invoke
	}
}

export class ForwardingTool implements vscode.LanguageModelTool<unknown> {
	prepareInvocation(): vscode.PreparedToolInvocation | undefined {
		if (raw === "") {
			return undefined; // allowed@11 return return in prepareInvocation
		}
		return sanctionedPrepared(raw); // allowed@10 return return in prepareInvocation
	}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<unknown>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		if (raw === "a") {
			return forwarded; // refused@11 return return in invoke
		}
		if (raw === "b") {
			return await vscode.lm.invokeTool("other", forwardOptions, token); // refused@17 return return in invoke
		}
		if (raw === "c") {
			return raw.length > 1 ? sanctionedResult(raw) : forwarded; // allowed@28 return return in invoke | refused@52 return return in invoke
		}
		if (raw === "d") {
			return (sanctionedResult(raw) as vscode.LanguageModelToolResult) ?? forwarded; // allowed@12 return return in invoke | refused@72 return return in invoke
		}
		if (raw === "e") {
			return exitNever(); // allowed@11 return return in invoke
		}
		[raw].map((item) => {
			return item;
		});
		return sanctionedResult(raw); // allowed@10 return return in invoke
	}
}

export class DerivedTool extends ForwardingTool {
	override async invoke(): Promise<vscode.LanguageModelToolResult> {
		return forwarded; // refused@10 return return in invoke
	}
}

export class NotATool {
	invoke(): vscode.LanguageModelToolResult {
		return forwarded;
	}
}

export const literalTool: vscode.LanguageModelTool<unknown> = {
	invoke: async () => forwarded, // refused@22 return return in invoke
	prepareInvocation() {
		return sanctionedPrepared(raw); // allowed@10 return return in prepareInvocation
	},
};

vscode.lm.registerTool("fixture", {
	invoke: async () => forwarded, // refused@22 return return in invoke
	prepareInvocation: () => ({ invocationMessage: raw }), // refused@28 construct { invocationMessage } | allowed@28 return return in prepareInvocation
});

const INVOKE = "invoke";

export class ComputedTool implements vscode.LanguageModelTool<unknown> {
	[INVOKE](): vscode.LanguageModelToolResult {
		return forwarded; // refused@10 return return in invoke
	}

	// biome-ignore lint/complexity/useLiteralKeys: the computed method-name shape
	["prepareInvocation"](): vscode.PreparedToolInvocation {
		return sanctionedPrepared(raw); // allowed@10 return return in prepareInvocation
	}
}

interface NamedTool extends vscode.LanguageModelTool<unknown> {
	readonly id: string;
}

export const namedTool: NamedTool = {
	id: "fixture",
	invoke: async () => forwarded, // refused@22 return return in invoke
};

export const taggedTool: vscode.LanguageModelTool<unknown> & { readonly id: string } = {
	id: "fixture",
	invoke: async () => forwarded, // refused@22 return return in invoke
};

export class ImplementsNamedTool implements NamedTool {
	readonly id = "fixture";

	invoke(): vscode.LanguageModelToolResult {
		return forwarded; // refused@10 return return in invoke
	}
}

export const optionalTool: vscode.LanguageModelTool<unknown> | undefined = {
	invoke: async () => forwarded, // refused@22 return return in invoke
};

export class WrappedMemberTool implements vscode.LanguageModelTool<unknown> {
	invoke = (async () => forwarded) satisfies vscode.LanguageModelTool<unknown>["invoke"]; // refused@24 return return in invoke
}

const implementation = {
	invoke() {
		return forwarded; // refused@10 return return in invoke
	},
};

vscode.lm.registerTool("spread", { ...implementation });

const invoke = () => forwarded; // refused@22 return return in invoke

export const shorthandTool: vscode.LanguageModelTool<unknown> = { invoke };

function externalResult(): vscode.LanguageModelToolResult {
	return forwarded; // refused@9 return return in invoke
}

export class DelegatingTool implements vscode.LanguageModelTool<unknown> {
	invoke = externalResult;
}

function otherResult(): vscode.LanguageModelToolResult {
	return forwarded; // refused@9 return return in invoke
}

vscode.lm.registerTool("identifier", { invoke: otherResult });

declare const external: vscode.LanguageModelTool<unknown>;

vscode.lm.registerTool("external", external); // refused@36 member invoke member not analyzable | refused@36 member prepareInvocation member not analyzable

declare function makeInvoke(): vscode.LanguageModelTool<unknown>["invoke"];

vscode.lm.registerTool("call", { invoke: makeInvoke() }); // refused@42 member invoke member not analyzable

export function install(invoke: vscode.LanguageModelTool<unknown>["invoke"] = () => undefined): void {
	// refused@25 member invoke member not analyzable
	vscode.lm.registerTool("parameter", { invoke });
}

declare function externalInvoke(): vscode.LanguageModelToolResult; // refused@1 member invoke member not analyzable

vscode.lm.registerTool("ambient", { invoke: externalInvoke });

const members = { invoke: () => sanctionedResult(raw) }; // allowed@33 return return in invoke

// biome-ignore lint/complexity/useLiteralKeys: the element-access member shape
vscode.lm.registerTool("element", { invoke: members["invoke"] });

vscode.lm.registerTool("getter", {
	get invoke() {
		return () => sanctionedResult(raw); // allowed@16 return return in invoke
	},
});

const spreadArguments = ["spread-call", { invoke: () => forwarded }] as const;

vscode.lm.registerTool(...spreadArguments); // refused@1 member invoke member not analyzable | refused@1 member prepareInvocation member not analyzable

const shared = () => sanctionedResult(raw); // allowed@22 return return in invoke
const first = shared;
const second = shared;

vscode.lm.registerTool("aliases", { invoke: raw === "" ? first : second });

const numeric = { 0: () => sanctionedResult(raw) }; // allowed@28 return return in invoke

vscode.lm.registerTool("numeric", { invoke: numeric[0] });

declare const choose: boolean;
const left = () => sanctionedResult(raw); // allowed@20 return return in invoke
const right = () => forwarded; // refused@21 return return in invoke

vscode.lm.registerTool("logical", { invoke: (choose && left) || right });

vscode.lm.registerTool("imported", new ImportedTool());

let mutable = () => sanctionedResult(raw); // refused@5 member invoke member not analyzable
if (raw === "") {
	mutable = () => forwarded;
}

vscode.lm.registerTool("mutable", { invoke: mutable });

export class ReassignedFieldTool implements vscode.LanguageModelTool<unknown> {
	invoke = () => sanctionedResult(raw); // refused@2 member invoke member not analyzable

	constructor() {
		this.invoke = () => forwarded;
	}
}

const reassigned = { invoke: () => sanctionedResult(raw) }; // refused@22 member invoke member not analyzable
reassigned.invoke = () => forwarded;

vscode.lm.registerTool("reassigned", reassigned);

const wrapped = { invoke: () => sanctionedResult(raw) }; // refused@19 member invoke member not analyzable
(wrapped.invoke as typeof wrapped.invoke) = () => forwarded;

vscode.lm.registerTool("wrapped", wrapped);

export function getterPrepared(): vscode.PreparedToolInvocation {
	return {
		// refused@9 construct { invocationMessage }
		get invocationMessage() {
			return raw;
		},
	};
}
