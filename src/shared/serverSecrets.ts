/**
 * The identity of a server entry's secret fields, shared by the settings side
 * (the servers setting and its SecretStorage blobs), the dashboard protocol,
 * and the sync engine. Pure constants: no vscode, no DOM, no Node.
 */

/** The three secret fields of a litellm-vscode-chat.servers entry; everything else is plain configuration. */
export const SECRET_FIELD_IDS = ["apiKey", "oauthClientSecret", "virtualKeyValue"] as const;
export type SecretFieldId = (typeof SECRET_FIELD_IDS)[number];

/** Where one secret field of a declared server lives. */
export type SecretLocation = "settings" | "secure" | "none";
