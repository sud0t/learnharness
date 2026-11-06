/**
 * Snippets as plain data, which is how they ship and how a learner's own set is
 * stored and edited. This file has no snippets of its own, so that settings can
 * check a stored set's shape without loading them.
 */

export type SnippetVariables = Record<string, string>;
/** A macro by name, and which of its arguments (from 0) count. All of them if unsaid. */
export type MacroArea = { name: string; arguments?: readonly number[] };

/** A snippet as data, in Latex Suite's own terms. `r` in `options` makes `trigger` a regex. */
export type RawSnippet = {
	trigger: string;
	replacement: string;
	options: string;
	flags?: string;
	priority?: number;
	description?: string;
	triggerAfter?: string;
	excludedMacros?: (string | MacroArea)[];
	excludedEnvironments?: string[];
	includedMacros?: (string | MacroArea)[];
};

/** A whole set. Without `variables`, the shipped ones apply. */
export type SnippetData = { variables?: SnippetVariables; snippets: RawSnippet[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The outer shape alone. Entries are checked when they compile, one by one, so
 *  that one bad entry never costs the rest. */
export function isSnippetData(value: unknown): value is SnippetData {
	if (!isRecord(value) || !Array.isArray(value.snippets)) return false;
	return value.variables === undefined || (isRecord(value.variables) && Object.values(value.variables).every((text) => typeof text === "string"));
}

/** A set as the editor shows it: one snippet to a line. */
export function snippetDataSource({ variables, snippets }: SnippetData): string {
	const list = snippets.map((snippet) => `    ${JSON.stringify(snippet)}`).join(",\n");
	const names = variables && Object.entries(variables).map(([name, text]) => `    ${JSON.stringify(name)}: ${JSON.stringify(text)}`).join(",\n");
	return `{\n${names === undefined ? "" : `  "variables": {\n${names}\n  },\n`}  "snippets": [\n${list}\n  ]\n}\n`;
}
