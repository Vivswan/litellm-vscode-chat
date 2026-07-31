import { isSafeMimeType } from "../../../shared/conversion/mime";

/**
 * Canonical base64 to bytes. ASCII whitespace is stripped first (MIME-style
 * wrapped base64 is the one legitimate variation); after that the payload
 * must be full 4-character groups over the standard alphabet with padding
 * only as a correct-length suffix, and re-encoding must reproduce it byte for
 * byte - Buffer.from(_, "base64") silently truncates short groups and zeroes
 * noncanonical pad bits ("AB=="), and corrupt media must surface as a logged
 * skip, never as garbage bytes.
 */
export function decodeBase64Strict(data: string): Uint8Array | undefined {
	const compact = data.replace(/[ \t\r\n]/g, "");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
		return undefined;
	}
	const bytes = Buffer.from(compact, "base64");
	if (bytes.toString("base64") !== compact) {
		return undefined;
	}
	return new Uint8Array(bytes);
}

export interface DecodedDataUrl {
	mime: string;
	bytes: Uint8Array;
}

/**
 * Decode a base64 data URL (the shape image-generating models emit); anything
 * else is undefined, for log-and-skip. The mime is model-controlled and later
 * reaches the host, so it is validated here at the source: type/subtype over
 * a conservative character set, with a length cap.
 */
export function decodeBase64DataUrl(url: string): DecodedDataUrl | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	if (!match) {
		return undefined;
	}
	const mime = match[1] as string;
	if (!isSafeMimeType(mime)) {
		return undefined;
	}
	const bytes = decodeBase64Strict(match[2] as string);
	return bytes === undefined ? undefined : { mime, bytes };
}

/** Base64 fragments of the in-flight generated audio output; see the accumulation comment on processAudioDelta. */
export interface AudioBuffer {
	id: string | undefined;
	base64: string;
}

/**
 * The request's audio.format values mapped to the mime stamped on the emitted
 * DataPart. The wire delta carries no format field, so the request parameter
 * is the only place the encoding is stated. pcm16 is raw samples without a
 * container; audio/pcm is the conventional type.
 */
const AUDIO_FORMAT_MIMES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	mp3: "audio/mpeg",
	flac: "audio/flac",
	opus: "audio/opus",
	aac: "audio/aac",
	pcm16: "audio/pcm",
};

/** audio/wav is the fallback for an absent or unknown format; every mapped value must still pass the safe-mime gate. */
export function audioMimeForFormat(format: string | undefined): string {
	const mime = format === undefined ? undefined : AUDIO_FORMAT_MIMES[format.toLowerCase()];
	return mime !== undefined && isSafeMimeType(mime) ? mime : "audio/wav";
}
