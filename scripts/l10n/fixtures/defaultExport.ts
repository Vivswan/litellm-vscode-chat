/** The default-export ban's own teeth: every shape that mints an importer-named binding must flag. */
export const DEFAULT_EXPORT_FIXTURES: readonly {
	readonly name: string;
	readonly source: string;
	readonly flagged: boolean;
}[] = [
	{ name: "export default expression", source: "const label = () => 1;\nexport default label;\n", flagged: true },
	{
		name: "export default function",
		source: "export default function label(): number {\n\treturn 1;\n}\n",
		flagged: true,
	},
	{ name: "export-equals", source: "const api = {};\nexport = api;\n", flagged: true },
	{
		name: "aliased default export specifier",
		source: "const label = () => 1;\nexport { label as default };\n",
		flagged: true,
	},
	{
		name: "namespace export named default",
		source: 'export * as default from "./foo";\n',
		flagged: true,
	},
	{ name: "namespace export under another name", source: 'export * as helpers from "./foo";\n', flagged: false },
	{ name: "named export", source: "export const label = () => 1;\n", flagged: false },
	{
		name: "type-only default-named export",
		source: "type T = number;\nexport { type T as default };\n",
		flagged: false,
	},
];
