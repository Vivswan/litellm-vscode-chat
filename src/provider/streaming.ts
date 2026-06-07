import * as vscode from "vscode";
import { tryParseJSONObject } from "../shared/json";
import type { ResponseCostTracker } from "./cost";

interface RequestState {
	toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
	completedToolCallIndices: Set<number>;
	hasEmittedAssistantText: boolean;
	emittedBeginToolCallsHint: boolean;
	textToolParserBuffer: string;
	textToolActive: undefined | { name?: string; index?: number; argBuffer: string; emitted?: boolean };
	emittedTextToolCallKeys: Set<string>;
	emittedTextToolCallIds: Set<string>;
}

export function freshRequestState(): RequestState {
	return {
		toolCallBuffers: new Map(),
		completedToolCallIndices: new Set(),
		hasEmittedAssistantText: false,
		emittedBeginToolCallsHint: false,
		textToolParserBuffer: "",
		textToolActive: undefined,
		emittedTextToolCallKeys: new Set(),
		emittedTextToolCallIds: new Set(),
	};
}

export class StreamProcessor {
	private _req: RequestState;
	private _toolCallIdCounter: number;
	private _log: (message: string, data?: unknown) => void;

	constructor(
		initialIdCounter: number,
		log: (message: string, data?: unknown) => void,
		private readonly costTracker?: ResponseCostTracker
	) {
		this._req = freshRequestState();
		this._toolCallIdCounter = initialIdCounter;
		this._log = log;
	}

	get toolCallIdCounter(): number {
		return this._toolCallIdCounter;
	}

	resetState(): void {
		this._req = freshRequestState();
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						await this.flushActiveTextToolCall(progress);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						await this.processDelta(parsed, progress);
					} catch (e) {
						this._log("Skipping malformed SSE line", { error: String(e), data: data.slice(0, 200) });
					}
				}
			}
		} finally {
			reader.releaseLock();
			this._req = freshRequestState();
		}
	}

	async processDelta(
		delta: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<boolean> {
		let emitted = false;

		const usage = delta.usage as Record<string, unknown> | undefined;
		if (usage) {
			this._log("Token usage", usage);
		}
		this.costTracker?.addDelta(delta);

		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) {
			return false;
		}

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		try {
			const maybeThinking =
				(choice as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.thinking ??
				(deltaObj as Record<string, unknown> | undefined)?.reasoning_content ??
				(deltaObj as Record<string, unknown> | undefined)?.reasoning;
			if (maybeThinking !== undefined) {
				const vsAny = vscode as unknown as Record<string, unknown>;
				const ThinkingCtor = vsAny["LanguageModelThinkingPart"] as
					| (new (text: string, id?: string, metadata?: unknown) => unknown)
					| undefined;
				if (ThinkingCtor) {
					let text = "";
					let id: string | undefined;
					let metadata: unknown;
					if (maybeThinking && typeof maybeThinking === "object") {
						const mt = maybeThinking as Record<string, unknown>;
						text = typeof mt["text"] === "string" ? (mt["text"] as string) : "";
						id = typeof mt["id"] === "string" ? (mt["id"] as string) : undefined;
						metadata = mt["metadata"];
					} else if (typeof maybeThinking === "string") {
						text = maybeThinking;
					}
					if (text) {
						progress.report(
							new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(
								text,
								id,
								metadata
							) as unknown as vscode.LanguageModelResponsePart
						);
						emitted = true;
					}
				}
			}
		} catch {
			// ignore errors here temporarily
		}

		if (deltaObj?.content !== undefined && deltaObj.content !== null) {
			if (Array.isArray(deltaObj.content)) {
				for (const block of deltaObj.content as Array<Record<string, unknown>>) {
					if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
						const res = this.processTextContent(block.text as string, progress);
						if (res.emittedText) {
							this._req.hasEmittedAssistantText = true;
						}
						if (res.emittedAny) {
							emitted = true;
						}
					}
				}
			} else {
				const content = String(deltaObj.content);
				const res = this.processTextContent(content, progress);
				if (res.emittedText) {
					this._req.hasEmittedAssistantText = true;
				}
				if (res.emittedAny) {
					emitted = true;
				}
			}
		}

		if (deltaObj?.tool_calls) {
			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			if (!this._req.emittedBeginToolCallsHint && this._req.hasEmittedAssistantText && toolCalls.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._req.emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				const idx = (tc.index as number) ?? 0;
				if (this._req.completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._req.toolCallBuffers.get(idx) ?? { args: "" };
				if (tc.id && typeof tc.id === "string") {
					buf.id = tc.id;
				}
				const func = tc.function as Record<string, unknown> | undefined;
				if (func?.name && typeof func.name === "string") {
					buf.name = func.name;
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments;
				}
				this._req.toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = (choice.finish_reason as string | undefined) ?? undefined;
		if (finish === "tool_calls" || finish === "stop") {
			await this.flushToolCallBuffers(progress, true);
		}

		return emitted;
	}

	processTextContent(
		input: string,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): { emittedText: boolean; emittedAny: boolean } {
		const BEGIN = "<|tool_call_begin|>";
		const ARG_BEGIN = "<|tool_call_argument_begin|>";
		const END = "<|tool_call_end|>";

		let data = this._req.textToolParserBuffer + input;
		this._req.textToolParserBuffer = "";
		let emittedText = false;
		let emittedAny = false;
		let visibleOut = "";

		while (data.length > 0) {
			if (!this._req.textToolActive) {
				const b = data.indexOf(BEGIN);
				if (b === -1) {
					const longestPartialPrefix = ((): number => {
						for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
							if (data.endsWith(BEGIN.slice(0, k))) {
								return k;
							}
						}
						return 0;
					})();
					if (longestPartialPrefix > 0) {
						const visible = data.slice(0, data.length - longestPartialPrefix);
						if (visible) {
							visibleOut += this.stripControlTokens(visible);
						}
						this._req.textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
					} else {
						visibleOut += this.stripControlTokens(data);
					}
					data = "";
					break;
				}
				const pre = data.slice(0, b);
				if (pre) {
					visibleOut += this.stripControlTokens(pre);
				}
				data = data.slice(b + BEGIN.length);

				const a = data.indexOf(ARG_BEGIN);
				const e = data.indexOf(END);
				let delimIdx: number;
				let delimKind: "arg" | "end";
				if (a !== -1 && (e === -1 || a < e)) {
					delimIdx = a;
					delimKind = "arg";
				} else if (e !== -1) {
					delimIdx = e;
					delimKind = "end";
				} else {
					this._req.textToolParserBuffer = BEGIN + data;
					data = "";
					break;
				}

				const header = data.slice(0, delimIdx).trim();
				const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
				const name = m?.[1] ?? undefined;
				const index = m?.[2] ? Number(m?.[2]) : undefined;
				this._req.textToolActive = { name, index, argBuffer: "", emitted: false };
				if (delimKind === "arg") {
					data = data.slice(delimIdx + ARG_BEGIN.length);
				} else {
					data = data.slice(delimIdx + END.length);
					const did = this.emitTextToolCallIfValid(progress, this._req.textToolActive, "{}");
					if (did) {
						this._req.textToolActive.emitted = true;
						emittedAny = true;
					}
					this._req.textToolActive = undefined;
				}
				continue;
			}

			const e2 = data.indexOf(END);
			if (e2 === -1) {
				this._req.textToolActive.argBuffer += data;
				if (!this._req.textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(
						progress,
						this._req.textToolActive,
						this._req.textToolActive.argBuffer
					);
					if (did) {
						this._req.textToolActive.emitted = true;
						emittedAny = true;
					}
				}
				data = "";
				break;
			} else {
				this._req.textToolActive.argBuffer += data.slice(0, e2);
				data = data.slice(e2 + END.length);
				if (!this._req.textToolActive.emitted) {
					const did = this.emitTextToolCallIfValid(
						progress,
						this._req.textToolActive,
						this._req.textToolActive.argBuffer
					);
					if (did) {
						emittedAny = true;
					}
				}
				this._req.textToolActive = undefined;
				continue;
			}
		}

		const textToEmit = visibleOut;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedText = true;
			emittedAny = true;
		}

		return { emittedText, emittedAny };
	}

	private emitTextToolCallIfValid(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
		argText: string
	): boolean {
		const name = call.name ?? "unknown_tool";
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return false;
		}
		const canonical = JSON.stringify(parsed.value);
		const key = `${name}:${canonical}`;
		if (typeof call.index === "number") {
			const idKey = `${name}:${call.index}`;
			if (this._req.emittedTextToolCallIds.has(idKey)) {
				return false;
			}
			this._req.emittedTextToolCallIds.add(idKey);
		} else if (this._req.emittedTextToolCallKeys.has(key)) {
			return false;
		}
		this._req.emittedTextToolCallKeys.add(key);
		const id = `tct_${++this._toolCallIdCounter}`;
		progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
		return true;
	}

	private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
		if (!this._req.textToolActive) {
			return;
		}
		const argText = this._req.textToolActive.argBuffer;
		const parsed = tryParseJSONObject(argText);
		if (!parsed.ok) {
			return;
		}
		this.emitTextToolCallIfValid(progress, this._req.textToolActive, argText);
		this._req.textToolActive = undefined;
	}

	private async tryEmitBufferedToolCall(
		index: number,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>
	): Promise<void> {
		const buf = this._req.toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${++this._toolCallIdCounter}`;
		const parameters = canParse.value;
		try {
			const canonical = JSON.stringify(parameters);
			this._req.emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
		} catch {
			/* ignore */
		}
		progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
		this._req.toolCallBuffers.delete(index);
		this._req.completedToolCallIndices.add(index);
	}

	private async flushToolCallBuffers(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._req.toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._req.toolCallBuffers.entries())) {
			const parsed = tryParseJSONObject(buf.args);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[LiteLLM Model Provider] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				continue;
			}
			const id = buf.id ?? `call_${++this._toolCallIdCounter}`;
			const name = buf.name ?? "unknown_tool";
			try {
				const canonical = JSON.stringify(parsed.value);
				this._req.emittedTextToolCallKeys.add(`${name}:${canonical}`);
			} catch {
				/* ignore */
			}
			progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
			this._req.toolCallBuffers.delete(idx);
			this._req.completedToolCallIndices.add(idx);
		}
	}

	private stripControlTokens(text: string): string {
		try {
			return text
				.replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
				.replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
		} catch {
			return text;
		}
	}
}
