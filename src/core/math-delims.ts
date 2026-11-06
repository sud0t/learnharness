/** Shared Markdown/TeX boundaries for legacy delimiter compatibility and
 * display-only tool-content recovery. Source arguments are never rewritten. */
import {
	canParseTex, knownTexCommand, mapMathContent, numericPercentEscape, outsideTexComments,
	readContentSpans, recoverDocumentLayout, texRanges,
} from "./content-reader.ts";

const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};

/** Preserve the legacy list-continuation policy: indented display math
 * degrades to inline rather than disrupting list structure. Literal code
 * indentation is already protected by the shared reader. */
function indented(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
	return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const delimiterRow = (line: string) => line.includes("|") && TABLE_DELIMITER.test(line);

/** True when the line at `i` belongs to a GFM table: a delimiter row sits
 * above it in the same block, or directly below it (the header row). Pipes
 * alone prove nothing, since `$$|x|$$` is ordinary math. */
function inTable(text: string, i: number): boolean {
	for (let end = text.lastIndexOf("\n", i - 1); end > 0;) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end);
		if (!line.trim()) break;
		if (delimiterRow(line)) return true;
		end = start - 1;
	}
	const eol = text.indexOf("\n", i);
	if (eol < 0) return false;
	const next = text.indexOf("\n", eol + 1);
	return delimiterRow(text.slice(eol + 1, next < 0 ? text.length : next));
}

/** Where a display block would break the surrounding structure: indented
 * content, list items, quotes, headings and table rows keep two-dollar math
 * inline. */
function staysInline(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return /^(?:[ \t]+|#{1,6}[ \t]|>|\||(?:[-*+]|\d+[.)])[ \t])/.test(prefix) || inTable(text, i);
}

/** A display fence for the span at `start`, padded with blank lines so a
 * mid-paragraph span splits the paragraph into a clean block. */
function displayBlock(text: string, start: number, raw: string, body: string): string {
	const before = blockPosition(text, start) ? "" : "\n\n";
	const end = start + raw.length;
	const after = end === text.length || text[end] === "\n" ? "" : "\n\n";
	return `${before}$$\n${body}\n$$${after}`;
}

/** micromark closes native single-dollar spans at escaped dollars too.
 * Replace an intended literal dollar with equivalent dollar-free TeX before
 * tokenization. Code, prose, unbalanced spans and display dollars stay raw. */
function replaceEscapedDollars(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
			out += "\\text{\\textdollar}"; i++;
		} else out += content[i];
	}
	return out;
}

/** Read old \(...\)/\[...\] syntax without touching literal content or
 * reparsing native math as Markdown. Dollar authoring remains native, except
 * that $$...$$ written inside a line displays as its own block, like a fence.
 * \(...\) still emits the two-dollar inline form: this is one pass over the
 * source, so that output is never read back as a display span. */
export function transformMathDelimiters(markdown: string): string {
	let offset = 0;
	return readContentSpans(markdown).map(span => {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math") return span.raw;
		if (span.open === "$") return "$" + replaceEscapedDollars(span.body) + span.close;
		const body = span.body.trim();
		if (span.open === "$$") {
			return span.display || !body || staysInline(markdown, start)
				? span.raw
				: displayBlock(markdown, start, span.raw, body);
		}
		if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
		if (!body) return span.raw;
		if (span.open === "\\(") return `$$${body}$$`;
		if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
		return displayBlock(markdown, start, span.raw, body);
	}).join("");
}

const DEBRIS: Record<string, string> = {
	"\b": "\\b", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\r": "\\r",
};

/** Recover JSON-swallowed command prefixes only in recognized math, never
 * in code or genuine TeX comments. Restore all debris in one pass. Physical
 * display newlines and CRLF remain source whitespace. Inline LF recovery is
 * limited to complete known n-command names. Under the approved typical-
 * model-authoring policy this includes newline+u→nu in inline math only;
 * already-correct commands are never decoded into whitespace. */
export function restoreMathEscapes(text: string): string {
	if (!/[\b\t\n\v\f\r]/.test(text)) return text;
	return mapMathContent(text, (body, display) => outsideTexComments(body, part => {
		const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
			if (char === "\r" && part[offset + 1] === "\n") return char;
			const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
			return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
		});
		if (display) return restored;
		return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
			knownTexCommand("n" + suffix) ? "\\n" + suffix : whole);
	}));
}

const commandSymbol = /[,;:!|{}%]/;

/** Decode prefixes and row separators according to ORIGINAL TeX context.
 * A native pair is literal; an encoded pair supplies a factor, so an encoded
 * four-backslash row becomes TWO, never a command prefix. Unknown commands
 * without that structural evidence are left alone. */
function recoverCommandRuns(inner: string, display: boolean): string {
	const ranges = texRanges(inner);
	const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
		const contexts = ranges.filter(r => offset >= r.start && offset < r.end);
		if (contexts.some(r => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0) return run;
		const next = inner[offset + run.length] ?? "";
		const encoded = contexts.filter(r => r.kind === "encoded").at(-1);
		const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
		if (encoded) {
			const factor = encoded.factor!;
			const rows = run.length % (2 * factor) === 0;
			const command = word ? knownTexCommand(word) : commandSymbol.test(next);
			if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
			return run;
		}
		if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
		if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
		return next && commandSymbol.test(next) ? "\\" : run;
	});
	// Structural evidence is primary (parse success cannot prove row
	// preservation). As an additional guard, never turn parseable source into
	// a parse failure through partial command recovery.
	if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display)) return inner;
	return recovered;
}

export function healOverescapedCommands(text: string): string {
	return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Presentation-only, language-independent recovery. Shape parsing, saved
 * identities, grading and model history must use the unprojected source. */
export function repairMathForDisplay(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));
}

export type MathSource = { start: number; end: number; bodyEnd: number; tex: string; display: boolean };

/** Every span transformMathDelimiters would show as math, in source offsets.
 * Shares its display rules so a draft previews as the sent message renders. */
export function readMathSources(markdown: string): MathSource[] {
	const sources: MathSource[] = [];
	let offset = 0;
	for (const span of readContentSpans(markdown)) {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math" || !span.body.trim()) continue;
		const display = span.open === "$" || span.open === "\\(" ? false
			: span.open === "$$" ? span.display || !staysInline(markdown, start)
			: span.open === "\\[" ? !indented(markdown, start)
			: span.display;
		sources.push({
			start, end: offset, display,
			// Past any trailing newline, or typing lands on a fence's closing line.
			bodyEnd: start + span.open.length + span.body.trimEnd().length,
			tex: span.open === "$" ? replaceEscapedDollars(span.body) : span.body.trim(),
		});
	}
	return sources;
}
