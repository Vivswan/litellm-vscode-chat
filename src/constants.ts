/**
 * Constants for LiteLLM VS Code Chat Provider
 * Centralized configuration values and magic numbers
 */

// Token estimation constants
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const IMAGE_TOKEN_ESTIMATE = 765; // Estimated tokens for a typical image
export const PDF_TOKEN_ESTIMATE = 500; // Estimated tokens for a typical PDF page

// Default token limits (fallback values when model info unavailable)
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_FALLBACK_MAX_TOKENS = 4096; // Used when no config or model info available

// Default model parameters
export const DEFAULT_TEMPERATURE = 0.7;

// API timeout settings (in milliseconds)
export const MODEL_FETCH_TIMEOUT = 30000; // 30 seconds
export const CHAT_REQUEST_TIMEOUT = 300000; // 5 minutes

// Tool call limits
export const MAX_TOOLS_PER_REQUEST = 128;

// Control tokens for inline tool call parsing
export const CONTROL_TOKENS = {
	TOOL_CALL_BEGIN: "<|tool_call_begin|>",
	TOOL_CALL_ARGUMENT_BEGIN: "<|tool_call_argument_begin|>",
	TOOL_CALL_END: "<|tool_call_end|>",
} as const;

// Provider-owned request fields that cannot be overwritten
export const PROVIDER_OWNED_FIELDS = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice"]);

// Function name constraints
export const MAX_FUNCTION_NAME_LENGTH = 64;

// Integer-like property name markers for schema sanitization
export const INTEGER_PROPERTY_MARKERS = [
	"id",
	"limit",
	"count",
	"index",
	"size",
	"offset",
	"length",
	"results_limit",
	"maxresults",
	"debugsessionid",
	"cellid",
] as const;
