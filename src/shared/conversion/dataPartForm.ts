import { audioInputFormatForMime, isImageMimeType, isPdfMimeType, isTextMimeType } from "./mime";

/** Where a DataPart sits in the request: a user message, assistant (or system) history, or inside a tool result. */
export type DataPartPosition = "user" | "assistant" | "toolResult";

/**
 * "none" covers payloads with no wire mapping at that position and payloads the model's capability gates exclude;
 * either way the part is dropped before the request is built.
 */
export type DataPartWireForm =
	| { form: "image" }
	| { form: "pdf" }
	| { form: "audio"; format: "wav" | "mp3" }
	| { form: "text" }
	| { form: "none" };

/**
 * Capability gates resolved from the model: the registered imageInput capability and the LiteLLM audio-input modality.
 * Capabilities decide what ships, so a gated-off part takes the same "none" path as an unmappable one.
 */
export interface DataPartWireGates {
	imageInput: boolean;
	audioInput: boolean;
}

function textOrNone(mime: string): DataPartWireForm {
	return isTextMimeType(mime) ? { form: "text" } : { form: "none" };
}

function userWireForm(mime: string, gates: DataPartWireGates): DataPartWireForm {
	if (gates.imageInput && isImageMimeType(mime)) {
		return { form: "image" };
	}

	if (isPdfMimeType(mime)) {
		return { form: "pdf" };
	}

	const format = audioInputFormatForMime(mime);
	if (gates.audioInput && format !== undefined) {
		return { form: "audio", format };
	}

	return textOrNone(mime);
}

function toolResultWireForm(mime: string, gates: DataPartWireGates): DataPartWireForm {
	if (isTextMimeType(mime)) {
		return { form: "text" };
	}

	if (gates.imageInput && isImageMimeType(mime)) {
		return { form: "image" };
	}

	return { form: "none" };
}

/**
 * The single wire-form decision for a DataPart; conversion switches on it at every position and token estimation
 * prices that output. Each position mirrors one conversion path exactly, ORDER included, so a text-decodable image
 * mime (image/foo+json) lands differently:
 *
 *   user message, vision gate on  -> image
 *   user message, vision gate off -> text
 *   tool result, any gate         -> text
 *   assistant or system history   -> text
 */
export function dataPartWireForm(
	mimeType: string,
	position: DataPartPosition,
	gates: DataPartWireGates
): DataPartWireForm {
	const mime = mimeType.toLowerCase();
	switch (position) {
		case "user":
			return userWireForm(mime, gates);
		case "assistant":
			return textOrNone(mime);
		case "toolResult":
			return toolResultWireForm(mime, gates);
		default:
			return position satisfies never;
	}
}
