import { audioInputFormatForMime, isImageMimeType, isPdfMimeType, isTextMimeType } from "./mime";

/** Where a DataPart sits in the request: a user message, assistant (or system) history, or inside a tool result. */
export type DataPartPosition = "user" | "assistant" | "toolResult";

/**
 * What a DataPart becomes on the wire at its position: an image_url block, a
 * file block, an input_audio block (carrying its resolved wire format),
 * decoded text, or nothing at all. "none" covers payloads with no wire mapping
 * at that position and payloads the model's capability gates exclude; either
 * way the part is dropped before the request is built.
 */
export type DataPartWireForm =
	| { form: "image" }
	| { form: "pdf" }
	| { form: "audio"; format: "wav" | "mp3" }
	| { form: "text" }
	| { form: "none" };

/**
 * Capability gates resolved from the model: the registered imageInput
 * capability and the LiteLLM audio-input modality. Capabilities decide what
 * ships, so a gated-off part takes the same "none" path as an unmappable one.
 */
export interface DataPartWireGates {
	imageInput: boolean;
	audioInput: boolean;
}

/**
 * This is the single wire-form decision for a DataPart.
 * Message conversion switches on this at every position, and token estimation prices its output.
 * Each position mirrors one conversion path exactly, and the ORDER matters.
 * User messages try the binary blocks first and fall back to the text decode.
 * A text-decodable image mime (image/foo+json) therefore goes as text when the vision gate is off.
 * Tool results decode text first and forward only gated images.
 * That same mime is therefore text in a tool result even for vision models.
 * Assistant and system history has no binary wire shape at all.
 */
export function dataPartWireForm(
	mimeType: string,
	position: DataPartPosition,
	gates: DataPartWireGates
): DataPartWireForm {
	const mime = mimeType.toLowerCase();
	switch (position) {
		case "user": {
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
			return isTextMimeType(mime) ? { form: "text" } : { form: "none" };
		}
		case "assistant":
			return isTextMimeType(mime) ? { form: "text" } : { form: "none" };
		case "toolResult":
			if (isTextMimeType(mime)) {
				return { form: "text" };
			}
			if (gates.imageInput && isImageMimeType(mime)) {
				return { form: "image" };
			}
			return { form: "none" };
		default:
			return position satisfies never;
	}
}
