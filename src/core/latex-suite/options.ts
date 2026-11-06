/**
 * A snippet's option letters and the modes they run in. Ported from Latex Suite
 * 1.13.3's editor_context/options.ts and default_text_areas.ts. MIT, Copyright
 * (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 */
import type { MacroArea } from "./snippet-data.ts";

/** Where the caret is, or, on a snippet, where it may run. */
export type Mode = {
	text: boolean;
	inlineMath: boolean;
	blockMath: boolean;
	/** Inside a fence whose language counts as math. */
	codeMath: boolean;
	codeBlock: string | boolean;
	/** Inline code. */
	code: boolean;
	/** Inside \text and its kin. */
	textEnv: boolean;
	/** Inside \tag, \begin and others that take no snippets at all. */
	snippetlessEnv: boolean;
};

export const noMode = (): Mode => ({ text: false, inlineMath: false, blockMath: false, codeMath: false, codeBlock: false, code: false, textEnv: false, snippetlessEnv: false });

export const inMath = (mode: Mode) => mode.inlineMath || mode.blockMath || mode.codeMath;
/** In math, and not in a text area of it. */
export const strictlyInMath = (mode: Mode) => inMath(mode) && !mode.textEnv;

export function modeFromOptions(source: string): Mode {
	const mode = noMode();
	for (const flag of source) {
		if (flag === "m") mode.blockMath = mode.inlineMath = true;
		else if (flag === "n") mode.inlineMath = true;
		else if (flag === "M") mode.blockMath = true;
		else if (flag === "t") mode.text = true;
		else if (flag === "T") mode.textEnv = true;
		else if (flag === "c") mode.codeBlock = true;
		else if (flag === "C") mode.code = true;
	}
	if (mode.textEnv && !(mode.blockMath || mode.inlineMath)) mode.blockMath = mode.inlineMath = true;
	if (mode.text || mode.inlineMath || mode.blockMath || mode.codeMath || mode.codeBlock !== false || mode.textEnv || mode.code) return mode;
	// No mode letter at all runs everywhere.
	return { text: true, inlineMath: true, blockMath: true, codeMath: true, codeBlock: true, code: true, textEnv: true, snippetlessEnv: true };
}

export type SnippetOptions = {
	mode: Mode;
	automatic: boolean;
	regex: boolean;
	onWordBoundary: boolean;
	visual: boolean;
	/** `U` clears this: the trigger's key is then no undo step of its own. */
	undoKey: boolean;
};

export function optionsFromSource(source: string): SnippetOptions {
	return {
		mode: modeFromOptions(source),
		automatic: source.includes("A"),
		regex: source.includes("r"),
		onWordBoundary: source.includes("w"),
		visual: source.includes("v"),
		undoKey: !source.includes("U"),
	};
}

export function snippetRunsInMode(snippet: Mode, mode: Mode, ignoreSnippetless = false): boolean {
	if (mode.snippetlessEnv && !ignoreSnippetless) return false;
	if ((snippet.inlineMath && mode.inlineMath) || (snippet.blockMath && mode.blockMath) || ((snippet.inlineMath || snippet.blockMath) && mode.codeMath)) {
		// Only where both agree on being inside \text.
		if (mode.textEnv === snippet.textEnv) return true;
	}
	if (snippet.text && mode.text) return true;
	if ((snippet.codeBlock === mode.codeBlock && mode.codeBlock !== false) || (snippet.codeBlock === true && mode.codeBlock !== false)) return true;
	return snippet.code && mode.code;
}

export type { MacroArea } from "./snippet-data.ts";

/** Where math commands are illegal and the content is LaTeX text instead. */
const textArea: readonly MacroArea[] = [
	{ name: "text", arguments: [0] },
	{ name: "textrm", arguments: [0] },
	{ name: "textup", arguments: [0] },
	{ name: "textit", arguments: [0] },
	{ name: "textbf", arguments: [0] },
	{ name: "textsf", arguments: [0] },
	{ name: "texttt", arguments: [0] },
	{ name: "textnormal", arguments: [0] },
	{ name: "clap", arguments: [0] },
	{ name: "textllap", arguments: [0] },
	{ name: "textrlap", arguments: [0] },
	{ name: "textclap", arguments: [0] },
	{ name: "hbox", arguments: [0] },
	{ name: "mbox", arguments: [0] },
	{ name: "fbox", arguments: [0] },
	{ name: "framebox", arguments: [0] },
	{ name: "colorbox", arguments: [1] }, // \colorbox{color}{text}
	{ name: "fcolorbox", arguments: [2] }, // \fcolorbox{color}{background-color}{text}
];

/** Where math commands are illegal and treating the content as text makes no sense either. */
export const snippetLessArea: readonly MacroArea[] = [
	{ name: "tag", arguments: [0] },
	{ name: "begin", arguments: [0] },
	{ name: "end", arguments: [0] },
	{ name: "mmlToken", arguments: [0, 1] },
	{ name: "unicode", arguments: [0] },
	{ name: "textcolor", arguments: [0] }, // Only the color: the second argument is math.
	{ name: "color", arguments: [0] },
	{ name: "colorbox", arguments: [0] },
	{ name: "fcolorbox", arguments: [0, 1] },
	{ name: "operatorname", arguments: [0] },
	{ name: "style", arguments: [0] },
];

export const allTextAreas: readonly MacroArea[] = [...textArea, ...snippetLessArea];
