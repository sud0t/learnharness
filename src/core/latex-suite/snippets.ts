/**
 * Latex Suite 1.13.3's snippet matching and expansion, on a source string and an
 * offset. Ported from snippets/parse.ts, snippets.ts, sort.ts, luasnip_api/node.ts,
 * features/run_snippets.ts and codemirror/snippet_queue_state_field.ts.
 * MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 *
 * Snippets are plain data here. What upstream's snippets do in JavaScript is either
 * converted to data (scripts/convert-latex-suite-snippets.mjs) or is the macro guard,
 * which is the one rule built into the engine.
 */
import macroNames from "./macros.json" with { type: "json" };
import defaults from "./snippets.json" with { type: "json" };
import { lineEnd, lineStart, macroScopeIn, type LatexContext, type ScopeEntry } from "./context.ts";
import { optionsFromSource, snippetRunsInMode, type SnippetOptions } from "./options.ts";
import { isSnippetData, type MacroArea, type RawSnippet, type SnippetData, type SnippetVariables } from "./snippet-data.ts";

export type { RawSnippet, SnippetVariables } from "./snippet-data.ts";

export type TabstopSpec = { index: number[]; from: number; to: number };

/** The built-in rule's two halves. */
type MacroGuard = "keep" | "space";

export type Snippet = {
	type: "string" | "regex" | "visual";
	trigger: string | RegExp;
	triggerAfter?: string | RegExp;
	replacement: string;
	guard?: MacroGuard;
	options: SnippetOptions;
	priority: number;
	description: string;
	excludedEnvironments: string[];
	excludedMacros: MacroArea[];
	includedMacros: MacroArea[];
	/** Where in its list this came from. A built-in rule has no place. */
	entry?: number;
	/** It runs a regex the app did not ship, which nobody has seen the cost of. */
	foreign?: boolean;
	/** That regex took too long on real text, and does not run again. */
	stopped?: boolean;
};

/** A regex as it runs. */
export type TriggerPattern = { source: string; flags: string };

export type SnippetSet = {
	/** Run on a typed key, before it lands. */
	automatic: Snippet[];
	/** Run on Tab. */
	onTab: Snippet[];
	/** Run on a key with a selection. */
	visual: Snippet[];
	macros: readonly string[];
};

/** Text going in, with what it brings. */
export type Insertion = {
	from: number;
	to: number;
	insert: string;
	/** Relative to `from`. */
	tabstops: TabstopSpec[];
	/** The key, when typing it is an undo step of its own. */
	key: string | null;
	/** Whether brackets around this get `\left` and `\right`. */
	enlarge: boolean;
};
export type Expansion = Insertion & { snippet: Snippet };

const VISUAL = "${VISUAL}";
const MACRO_TRIGGER = String.raw`\\[A-Za-z]{2,}`;
/** `wordDelimiters`, unchanged by this user. */
const WORD_DELIMITERS = "., +-\n\t:;!?\\/{}[]()=~$'\"|`<>*^%#@&";
/** Obsidian's defaults: indent with tabs, four wide. */
const TAB_SIZE = 4;
/** A trigger looks back this far at most. Upstream hands every regex the whole
 *  document, which is quadratic on a long run of letters. Past any real trigger. */
const WINDOW = 1024;
/** Stands in for the text before a cut, so that `^` cannot match at it. */
const CUT = "￿";
/** A learner's regex that takes this long on one key is not run again. */
const TOO_SLOW_MS = 100;

/** `autoEnlargeBracketsTriggers`, unchanged by this user. */
export const ENLARGE_TRIGGERS = ["sum", "int", "frac", "prod", "bigcup", "bigcap"];

/** Triggers that must not run inside a macro, whoever wrote the snippet. */
const EXCLUSIONS: Record<string, MacroArea[]> = {
	"([A-Za-z])(\\d)": [{ name: "ce" }, { name: "pu" }],
	"->": [{ name: "ce" }],
};

function filterFlags(flags: string) {
	return [...new Set(flags)].filter((flag) => "imsuv".includes(flag)).join("");
}

function insertVariables(trigger: string, variables: SnippetVariables) {
	for (const [variable, replacement] of Object.entries(variables)) trigger = trigger.replaceAll(variable, replacement);
	return trigger;
}

const macroArea = (item: string | MacroArea): MacroArea => (typeof item === "string" ? { name: item, arguments: [0] } : item);

const isText = (value: unknown) => typeof value === "string";
const isTextList = (value: unknown) => Array.isArray(value) && value.every(isText);
const isMacroList = (value: unknown) => Array.isArray(value) && value.every((item) => isText(item) || (
	typeof item === "object" && item !== null && Object.keys(item).every((key) => key === "name" || key === "arguments") && isText((item as MacroArea).name)
	&& ((item as MacroArea).arguments === undefined || (Array.isArray((item as MacroArea).arguments) && (item as MacroArea).arguments!.every(Number.isInteger)))
));
const FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
	trigger: isText, replacement: isText, options: isText, flags: isText, description: isText, triggerAfter: isText,
	priority: Number.isFinite, excludedEnvironments: isTextList, excludedMacros: isMacroList, includedMacros: isMacroList,
};

/** An entry can come from anyone's hand. Nothing past here may trip over its shape. */
function checkShape(raw: unknown) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("a snippet is an object");
	for (const [field, value] of Object.entries(raw)) {
		if (!Object.hasOwn(FIELDS, field)) throw new Error(`"${field}" is not a snippet field`);
		if (!FIELDS[field]!(value)) throw new Error(`"${field}" has the wrong type`);
	}
}

function compileOne(raw: RawSnippet, variables: SnippetVariables, guard?: MacroGuard): Snippet {
	checkShape(raw);
	if (typeof raw.trigger !== "string" || !raw.trigger) throw new Error("a snippet needs a trigger");
	if (typeof raw.replacement !== "string") throw new Error("the replacement must be text");
	if (typeof raw.options !== "string") throw new Error("the options must be text");
	const options = optionsFromSource(raw.options);
	const common = {
		replacement: raw.replacement,
		options,
		guard,
		priority: raw.priority ?? 0,
		description: raw.description ?? "",
		excludedEnvironments: raw.excludedEnvironments ?? [],
		includedMacros: (raw.includedMacros ?? []).map(macroArea),
	};
	const trigger = insertVariables(raw.trigger, variables);
	const excludedMacros = [...(EXCLUSIONS[trigger] ?? []), ...(raw.excludedMacros ?? []).map(macroArea)];
	if (options.regex) {
		const flags = filterFlags(raw.flags ?? "");
		const after = raw.triggerAfter && insertVariables(raw.triggerAfter, variables);
		return {
			...common,
			type: "regex",
			// A match has to end at the cursor.
			trigger: new RegExp(`(?:${trigger})$`, flags),
			triggerAfter: after ? new RegExp(`^(?:${after})`, flags) : undefined,
			excludedMacros,
		};
	}
	const after = raw.triggerAfter === undefined ? undefined : insertVariables(raw.triggerAfter, variables);
	if (raw.replacement.includes(VISUAL) && trigger.length <= 1) options.visual = true;
	if (options.visual) {
		if (trigger.length > 1) throw new Error("a visual snippet's trigger is a single character");
		options.automatic = false;
		return { ...common, type: "visual", trigger, excludedMacros };
	}
	return { ...common, type: "string", trigger, triggerAfter: after, excludedMacros };
}

function triggerLength(snippet: Snippet) {
	return typeof snippet.trigger === "string" ? snippet.trigger.length : snippet.trigger.source.length;
}

/** By priority, then the longer trigger, then file order. */
function sortSnippets(snippets: Snippet[]) {
	return snippets
		.map((snippet, order) => ({ snippet, order, priority: snippet.priority, length: triggerLength(snippet) }))
		.sort((a, b) => b.priority - a.priority || b.length - a.length || a.order - b.order)
		.map(({ snippet }) => snippet);
}

const builtIn: { raw: RawSnippet; guard: MacroGuard }[] = [
	{ raw: { trigger: MACRO_TRIGGER, replacement: "", options: "rmAU", priority: 3, description: "Disable snippets while typing macros" }, guard: "keep" },
	{ raw: { trigger: MACRO_TRIGGER, replacement: "", options: "rmA", priority: 3, description: "Insert space after macros if not part of another macro" }, guard: "space" },
];

type Compiled = { snippets: SnippetSet; errors: string[] };

function compileList(entries: readonly RawSnippet[], variables: SnippetVariables, macros: readonly string[]): Compiled {
	const list: Snippet[] = [];
	const errors: string[] = [];
	entries.forEach((raw, index) => {
		try { list.push({ ...compileOne(raw, variables), entry: index }); }
		catch (error) {
			const trigger = typeof raw?.trigger === "string" && raw.trigger ? ` (trigger: ${raw.trigger})` : "";
			errors.push(`Snippet ${index + 1}: ${(error as Error).message}${trigger}`);
		}
	});
	for (const { raw, guard } of builtIn) list.push(compileOne(raw, variables, guard));
	const sorted = sortSnippets(list);
	return {
		errors,
		snippets: {
			automatic: sorted.filter((snippet) => snippet.options.automatic),
			onTab: sorted.filter((snippet) => !snippet.options.automatic && !snippet.options.visual),
			visual: sorted.filter((snippet) => snippet.options.visual),
			macros,
		},
	};
}

/** The snippets as data, for the editor to start from. */
export const defaultSnippetData = (): SnippetData => defaults;

let shipped: SnippetSet | null = null;
/** The snippets the app ships. Compiled once, on first use. */
export function defaultSnippets(): SnippetSet {
	return shipped ??= compileList(defaults.snippets, defaults.variables, macroNames).snippets;
}

const regexesOf = (set: SnippetSet) => [...set.automatic, ...set.onTab];

function patternsOf({ trigger, triggerAfter }: Snippet): TriggerPattern[] {
	return [trigger, triggerAfter].flatMap((regex) => (regex instanceof RegExp ? [{ source: regex.source, flags: regex.flags }] : []));
}

/** How a verdict on a regex is filed. */
export const patternKey = ({ source, flags }: TriggerPattern) => `${flags}/${source}`;

let shippedPatterns: Set<string> | null = null;
function isShipped(pattern: TriggerPattern) {
	shippedPatterns ??= new Set(regexesOf(defaultSnippets()).flatMap(patternsOf).map(patternKey));
	return shippedPatterns.has(patternKey(pattern));
}

/** A bad entry is reported and skipped, and never takes the others with it. */
export function compileSnippets(entries: readonly RawSnippet[], variables: SnippetVariables, macros: readonly string[] = macroNames): Compiled {
	const result = compileList(entries, variables, macros);
	for (const snippet of regexesOf(result.snippets)) snippet.foreign = !patternsOf(snippet).every(isShipped);
	return result;
}

const compiled = new WeakMap<SnippetData, Compiled>();
function compileData(data: SnippetData) {
	let result = compiled.get(data);
	if (!result) compiled.set(data, result = compileSnippets(data.snippets, data.variables ?? defaults.variables));
	return result;
}

/** A learner's set, or the shipped one. Whatever a record holds, this gives a set
 *  that works: what is wrong with one entry costs only that entry. A regex the app
 *  did not ship stays out until `passes` says it is safe to run. */
export function snippetSetFor(data: SnippetData | null | undefined, passes: (pattern: TriggerPattern) => boolean = () => false): SnippetSet {
	if (!data) return defaultSnippets();
	const { snippets } = compileData(data);
	const allowed = (snippet: Snippet) => !snippet.foreign || patternsOf(snippet).every((pattern) => isShipped(pattern) || passes(pattern));
	if (regexesOf(snippets).every(allowed)) return snippets;
	return { ...snippets, automatic: snippets.automatic.filter(allowed), onTab: snippets.onTab.filter(allowed) };
}

/** The regexes of a set that have to pass before they run, entry by entry. */
export function unvettedSnippets(data: SnippetData): { entry: number; trigger: string; patterns: TriggerPattern[] }[] {
	return regexesOf(compileData(data).snippets)
		.filter((snippet) => snippet.foreign && snippet.entry !== undefined)
		.sort((a, b) => a.entry! - b.entry!)
		.map((snippet) => ({ entry: snippet.entry!, trigger: data.snippets[snippet.entry!]!.trigger!, patterns: patternsOf(snippet).filter((pattern) => !isShipped(pattern)) }));
}

/** What is wrong with a stored set, entry by entry. */
export const snippetDataErrors = (data: SnippetData) => compileData(data).errors;

/** Text from the editor. No `data` means nothing should be saved, and `errors` says why. */
export function parseSnippetSource(text: string): { data: SnippetData | null; errors: string[] } {
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch (error) { return { data: null, errors: [`This is not valid JSON: ${(error as Error).message}`] }; }
	if (!isSnippetData(parsed)) return { data: null, errors: ['This needs to be an object with a "snippets" list, and any "variables" as text.'] };
	const errors = snippetDataErrors(parsed);
	return { data: errors.length ? null : parsed, errors };
}

function expandCaptures(text: string, match: (string | undefined)[]) {
	return text.replace(/\[\[(\d+)\]\]/g, (all, digits: string) => {
		const index = Number(digits);
		return index >= match.length ? all : match[index] ?? "";
	});
}

/** `$n` is one digit, a placeholder holds no `}`, and `${}` and `$$` are literal. */
export function expandTabstops(text: string): { insert: string; tabstops: TabstopSpec[] } {
	let insert = "", offset = 0;
	const tabstops: TabstopSpec[] = [];
	for (const match of text.matchAll(/\$(\d)|\$\{(\d+):([^}]*)\}/g)) {
		insert += text.slice(offset, match.index);
		const placeholder = match[3] ?? "";
		tabstops.push({ index: [Number(match[1] || match[2])], from: insert.length, to: insert.length + placeholder.length });
		insert += placeholder;
		offset = match.index + match[0].length;
	}
	return { insert: insert + text.slice(offset), tabstops };
}

function trimWhitespace(replacement: { insert: string; tabstops: TabstopSpec[] }) {
	replacement.insert = replacement.insert.trimEnd();
	for (const tabstop of replacement.tabstops) {
		tabstop.to = Math.min(tabstop.to, replacement.insert.length);
		tabstop.from = Math.min(tabstop.from, replacement.insert.length);
	}
}

function countColumn(text: string) {
	let column = 0;
	for (const ch of text) column += ch === "\t" ? TAB_SIZE - (column % TAB_SIZE) : 1;
	return column;
}

function indentString(columns: number) {
	return "\t".repeat(Math.floor(columns / TAB_SIZE)) + " ".repeat(columns % TAB_SIZE);
}

/** New lines in a replacement take the indent and quote markers of the line they start from. */
export function keepIndentAndCallout(source: string, to: number, replacement: { insert: string; tabstops: TabstopSpec[] }) {
	if (!replacement.insert.includes("\n")) return;
	const lineStart = source.lastIndexOf("\n", to - 1) + 1;
	const lineEnd = source.indexOf("\n", to);
	const [, callouts, indentation] = /^(>*)(\s*)/.exec(source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd))!;
	const column = countColumn(indentation!);
	const misalignment = column % TAB_SIZE;
	let output = "", last = 0, offset = 0;
	for (const match of replacement.insert.matchAll(/\n(\t*)/g)) {
		const tabs = match[1]!.length;
		const newIndent = `\n${callouts}${indentString(tabs * TAB_SIZE + column - (tabs && misalignment))}`;
		const added = newIndent.length - match[0].length;
		for (const tabstop of replacement.tabstops) {
			if (tabstop.from - offset > match.index) tabstop.from += added;
			if (tabstop.to - offset > match.index) tabstop.to += added;
		}
		offset += added;
		output += replacement.insert.slice(last, match.index) + newIndent;
		last = match.index + match[0].length;
	}
	replacement.insert = output + replacement.insert.slice(last);
}

function isOnWordBoundary(source: string, from: number, to: number) {
	return WORD_DELIMITERS.includes(source.slice(Math.max(0, from - 1), from)) && WORD_DELIMITERS.includes(source.slice(to, to + 1));
}

function isExcluded(snippet: Snippet, stack: ScopeEntry[]) {
	if (!snippet.excludedEnvironments.length && !snippet.excludedMacros.length) return false;
	for (const entry of stack) {
		if (entry.kind === "environment") {
			if (snippet.excludedEnvironments.includes(entry.name)) return true;
		} else if (entry.kind === "math") return false;
		else if (macroScopeIn(entry, snippet.excludedMacros)) return true;
	}
	return false;
}

/** Null when the snippet names no macros, then whether the innermost one is listed. */
function isIncluded(snippet: Snippet, stack: ScopeEntry[]): boolean | null {
	if (!snippet.includedMacros.length) return null;
	const first = stack.find((entry) => entry.kind !== "environment");
	if (!first || first.kind !== "command") return false;
	return macroScopeIn(first, snippet.includedMacros);
}

function runsHere(snippet: Snippet, { mode, stack }: LatexContext) {
	const included = isIncluded(snippet, stack);
	return snippetRunsInMode(snippet.options.mode, mode, included === true) && included !== false;
}

const enlarges = (insert: string) => ENLARGE_TRIGGERS.some((word) => insert.includes(word));

type Matched = { from: number; end: number; text: string; match: (string | undefined)[] };

/** The last line of defence for a learner's regex, which only helps with the next
 *  key: the one that ran is already over by the time its cost is known. */
function runRegex(snippet: Snippet, regex: RegExp, text: string) {
	if (!snippet.foreign) return regex.exec(text);
	const started = performance.now();
	const result = regex.exec(text);
	if (performance.now() - started > TOO_SLOW_MS) {
		snippet.stopped = true;
		console.warn(`A snippet trigger took too long and is off until it changes: ${regex.source}`);
	}
	return result;
}

function matchTrigger(snippet: Snippet, text: string, shift: number, after: () => string): Matched | null {
	const { trigger, triggerAfter } = snippet;
	if (typeof trigger === "string") {
		if (!text.endsWith(trigger)) return null;
		let extra = 0;
		if (typeof triggerAfter === "string") {
			if (!after().startsWith(triggerAfter)) return null;
			extra = triggerAfter.length;
		}
		return { from: text.length - trigger.length + shift, end: extra, text: trigger, match: [trigger] };
	}
	const result = runRegex(snippet, trigger, text);
	if (!result) return null;
	let extra = 0;
	if (triggerAfter instanceof RegExp) {
		const found = runRegex(snippet, triggerAfter, after());
		if (!found) return null;
		extra = found[0].length;
	}
	return { from: result.index + shift, end: extra, text: result[0], match: result.slice(1) };
}

function guardReplacement(guard: MacroGuard, text: string, macros: readonly string[]): string | null {
	const known = macros.some((name) => name.startsWith(text));
	if (guard === "keep") return known ? text : null;
	if (known) return null;
	const body = text.slice(1);
	return `\\${body.slice(0, -1)} ${body.slice(-1)}`;
}

/**
 * The first snippet that fires at `to` with `key` about to land there, in sorted
 * order. A Tab press has no key. Context is read at the first trigger that matches,
 * so a key that matches nothing never parses the draft. A learner's regex is the
 * exception, and is asked first, so that it only ever runs where it can fire.
 */
export function findExpansion(snippets: Snippet[], macros: readonly string[], source: string, to: number, key: string, read: (offset: number) => LatexContext): Expansion | null {
	const start = Math.max(0, to - WINDOW);
	// What stands before the window, so that `^` still means the start of the text.
	const before = start === 0 ? "" : source[start - 1] === "\n" ? "\n" : CUT;
	const text = `${before}${source.slice(start, to)}${key}`;
	const shift = start - before.length;
	let afterText: string | null = null;
	const after = () => afterText ??= source.slice(to, to + WINDOW);
	let context: LatexContext | null = null;

	for (const snippet of snippets) {
		if (snippet.stopped) continue;
		if (snippet.foreign) {
			context ??= read(to);
			if (!runsHere(snippet, context) || isExcluded(snippet, context.stack)) continue;
		}
		const matched = matchTrigger(snippet, text, shift, after);
		if (!matched) continue;
		context ??= read(to);
		if (!runsHere(snippet, context)) continue;
		const output = snippet.guard ? guardReplacement(snippet.guard, matched.text, macros) : snippet.replacement;
		if (output === null) continue;
		if (isExcluded(snippet, context.stack)) continue;
		if (snippet.options.onWordBoundary && !isOnWordBoundary(source, matched.from, to)) continue;
		const replacement = expandTabstops(snippet.type === "regex" && !snippet.guard ? expandCaptures(output, matched.match) : output);
		if (context.mode.inlineMath) trimWhitespace(replacement);
		keepIndentAndCallout(source, to, replacement);
		return {
			from: matched.from,
			to: to + matched.end,
			insert: replacement.insert,
			tabstops: replacement.tabstops,
			key: key && snippet.options.automatic && snippet.options.undoKey ? key : null,
			enlarge: enlarges(replacement.insert),
			snippet,
		};
	}
	return null;
}

/** A selection without the indent and quote markers of its lines, which are not
 *  really part of its text. Only when every line has them. */
function selectedText(source: string, from: number, to: number): { from: number; text: string } {
	const selected = source.slice(from, to);
	const start = lineStart(source, from);
	const [, quotes, indent] = /^((?:> ?)*)(\s*)/.exec(source.slice(start, lineEnd(source, from)))!;
	const depth = quotes!.split(">").length;
	let uneven = false;
	const text = selected.replaceAll(/\n((?:> ?)*)(\s*)/g, (all: string, lineQuotes: string, lineIndent: string) => {
		if (uneven) return all;
		if (lineQuotes.split(">").length === depth && lineIndent.length >= indent!.length) return "\n";
		uneven = true;
		return all;
	});
	if (uneven) return { from, text: selected };
	if (start !== from) return { from, text };
	return { from: from + /^(> ?)*\s*/.exec(text)![0].length, text: text.replace(/^((?:> ?)*)(\s*)/, "") };
}

/** The first visual snippet to wrap a selection on this key. The whole result stays
 *  selected if it has no stops, so that wraps chain. */
export function findVisual(snippets: Snippet[], source: string, from: number, to: number, key: string, read: (offset: number) => LatexContext): Expansion | null {
	const list = snippets.filter(({ trigger }) => trigger === key);
	if (!list.length || from === to) return null;
	const selection = selectedText(source, from, to);
	if (!selection.text) return null;
	const context = read(to);
	for (const snippet of list) {
		if (!runsHere(snippet, context) || isExcluded(snippet, context.stack)) continue;
		if (snippet.options.onWordBoundary && !isOnWordBoundary(source, from, to)) continue;
		const replacement = expandTabstops(snippet.replacement.replaceAll(VISUAL, () => selection.text));
		if (!replacement.tabstops.length) {
			replacement.insert = source.slice(from, selection.from) + replacement.insert;
			replacement.tabstops = [{ index: [0], from: 0, to: replacement.insert.length }];
		}
		if (context.mode.inlineMath) trimWhitespace(replacement);
		keepIndentAndCallout(source, to, replacement);
		return { from, to, insert: replacement.insert, tabstops: replacement.tabstops, key: null, enlarge: enlarges(replacement.insert), snippet };
	}
	return null;
}
