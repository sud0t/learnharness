/**
 * Closing pairs, as Obsidian 1.15 types them. Ported from closeBrackets in
 * @codemirror/autocomplete. MIT, Copyright (C) 2018-2021 Marijn Haverbeke and others:
 * see THIRD_PARTY_NOTICES.md.
 *
 * The code here is CodeMirror's MIT code. The behaviour on top of it was matched to
 * Obsidian by observing how Obsidian behaves, and no Obsidian code is in this project.
 *
 * Obsidian's editor runs an older copy of closeBrackets that it changed, so these
 * rules follow that copy where the package has since moved on:
 * - Brackets also pair in front of a quote mark.
 * - A quote or Markdown symbol pairs only with white space, or the edge of the text,
 *   on both sides of the caret. The package looks for word characters instead.
 * - Typing over a selection of several lines replaces it with the pair, though a
 *   backtick still wraps it.
 * - The third backtick opens a fence on two lines, which also wraps a selection.
 * - Stepping over a closer moves the caret and changes no text.
 * - Moving to another line forgets every closer. The package keeps the current line's.
 * - `$ = ~ %` wrap a selection and do nothing else, so they leave no closer.
 * - Brackets and quotes are one setting, Markdown symbols another. `$ = ~ %` work
 *   with either on.
 *
 * CodeMirror also asks its syntax tree whether a node starts at an offset, and a box
 * has no such tree. Text is treated as flat, so typing a symbol right before a longer
 * run of it (`|**bold**`) is plain typing here. Two backticks count as a node's start
 * unless a third comes before them, which is all the fence rule needs.
 */
import { parseFilePaths } from "./file-paths.ts";

/** Which pairs close. Obsidian's "Auto pair brackets" and "Auto pair Markdown". */
export type PairKinds = { brackets: boolean; markdown: boolean };
export const EVERY_PAIR: PairKinds = { brackets: true, markdown: true };

export type PairCursor = { anchor: number; focus: number };
/** `from` to `to` became `text`, on the text the edit before this one left. */
export type PairEdit = { from: number; to: number; length: number; text: string };
export type PairChange = {
	/** One after another. Empty when the carets only stepped over closers. */
	edits: PairEdit[];
	/** Where the cursors end up, in the new text. */
	cursors: PairCursor[];
	/** Closers this put in, in the new text. */
	closers: number[];
	/** Closers stepped over, in the old text. */
	passed: number[];
};

const BRACKETS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = "'\"";
const MARKDOWN = "*_`";
const WRAP_ONLY = "=~$%";
/** What a bracket pairs in front of, besides white space and the end of the text. */
const BEFORE = ")]}'\":;>";
const FENCE = "`";
const LIST_LINE = /^([>\s]*)([*+-] |\d+[.)] )?/;

/** One cursor's part. Offsets are in the old text, plus this cursor's own edits. */
type Step = {
	parts: { from: number; to: number; text: string }[];
	anchor: number;
	focus: number;
	closer?: number;
	passed?: number;
};

const span = ({ anchor, focus }: PairCursor) => ({ from: Math.min(anchor, focus), to: Math.max(anchor, focus) });
const isSpace = (text: string) => !/\S/.test(text);
const lineStart = (value: string, at: number) => (at <= 0 ? 0 : value.lastIndexOf("\n", at - 1) + 1);
const crossesLines = (value: string, from: number, to: number) => value.slice(from, to).includes("\n");
const twoBefore = (value: string, at: number) => (at < 2 ? "" : value.slice(at - 2, at));

/** What a new line needs to stay inside the quote or list item this offset is in. */
function continuation(value: string, at: number) {
	const end = value.indexOf("\n", at);
	const [, prefix, marker] = LIST_LINE.exec(value.slice(lineStart(value, at), end < 0 ? value.length : end))!;
	return prefix! + " ".repeat(marker?.length ?? 0);
}

function inserted(at: number, text: string): Step {
	const caret = at + 1;
	return { parts: [{ from: at, to: at, text }], anchor: caret, focus: caret, closer: caret };
}
function wrapped(cursor: PairCursor, before: string, after: string, closes = true): Step {
	const { from, to } = span(cursor);
	return {
		parts: [{ from, to: from, text: before }, { from: to, to, text: after }],
		anchor: cursor.anchor + before.length,
		focus: cursor.focus + before.length,
		closer: closes ? to + before.length : undefined,
	};
}
function replaced(cursor: PairCursor, open: string, close: string): Step {
	const { from, to } = span(cursor);
	const caret = from + open.length;
	return { parts: [{ from, to, text: open + close }], anchor: caret, focus: caret, closer: caret };
}
const stepped = (at: number, size: number): Step => ({ parts: [], anchor: at + size, focus: at + size, passed: at });

function openBracket(value: string, cursor: PairCursor, open: string, close: string): Step | null {
	const { from, to } = span(cursor);
	if (from !== to) return crossesLines(value, from, to) ? replaced(cursor, open, close) : wrapped(cursor, open, close);
	const next = value[from];
	return !next || /\s/.test(next) || BEFORE.includes(next) ? inserted(from, open + close) : null;
}

function closeBracket(value: string, cursor: PairCursor, close: string): Step | null {
	const { from, to } = span(cursor);
	return from === to && value[from] === close ? stepped(from, close.length) : null;
}

function wrapSymbol(value: string, cursor: PairCursor, token: string): Step {
	const { from, to } = span(cursor);
	if (token === FENCE && twoBefore(value, from) === token + token) {
		const indent = continuation(value, from);
		return wrapped(cursor, value[from] === "\n" ? token : `${token}\n${indent}`, value[to - 1] === "\n" ? token : `\n${indent}${token}`);
	}
	return token !== FENCE && crossesLines(value, from, to) ? replaced(cursor, token, token) : wrapped(cursor, token, token);
}

function typeSymbol(value: string, cursor: PairCursor, token: string, closers: readonly number[]): Step | null {
	const { from, to } = span(cursor);
	if (from !== to) return wrapSymbol(value, cursor, token);
	const next = value[from] ?? "";
	if (next === token) {
		if (!closers.includes(from)) return null;
		return stepped(from, token === FENCE && value.startsWith(token.repeat(3), from) ? 3 : 1);
	}
	if (token === FENCE && twoBefore(value, from) === token + token && value[from - 3] !== token) {
		return inserted(from, `${token}\n${continuation(value, from)}${token.repeat(3)}`);
	}
	return isSpace(next) && isSpace(value.slice(Math.max(0, from - 1), from)) ? inserted(from, token + token) : null;
}

/** Every cursor takes its step, or none does and the key is plain typing. */
function together(cursors: readonly PairCursor[], step: (cursor: PairCursor) => Step | null): PairChange | null {
	const steps: Step[] = [];
	for (const cursor of [...cursors].sort((a, b) => span(a).from - span(b).from)) {
		const taken = step(cursor);
		if (!taken) return null;
		steps.push(taken);
	}
	const change: PairChange = { edits: [], cursors: [], closers: [], passed: [] };
	let shift = 0;
	for (const { parts, anchor, focus, closer, passed } of steps) {
		const base = shift;
		for (const { from, to, text } of parts) {
			change.edits.push({ from: from + shift, to: to + shift, length: text.length, text });
			shift += text.length - (to - from);
		}
		change.cursors.push({ anchor: anchor + base, focus: focus + base });
		if (closer !== undefined) change.closers.push(closer + base);
		if (passed !== undefined) change.passed.push(passed);
	}
	return change;
}

/**
 * A rooted path is a whole file chip from its first characters, so with a closer in
 * place `/` would turn into a chip of its own and put the caret past it. The closer
 * goes instead, and the path types on as it does with pairs off, for the backtick
 * at its end to make the chip.
 */
function pathInBackticks(value: string, cursor: PairCursor, key: string, closers: readonly number[]): Step | null {
	const { from, to } = span(cursor);
	if (from !== to || value[from] !== FENCE || !closers.includes(from)) return null;
	const caret = from + key.length;
	const typed = value.slice(0, from) + key + value.slice(from);
	if (!parseFilePaths(typed).some((part) => part.kind === "path" && part.start < caret && part.end > caret)) return null;
	return { parts: [{ from, to: from + 1, text: key }], anchor: caret, focus: caret };
}

/** What `key` does at these cursors, or null when it is plain typing. */
export function insertPair(value: string, cursors: readonly PairCursor[], key: string, closers: readonly number[], kinds: PairKinds = EVERY_PAIR): PairChange | null {
	const path = kinds.markdown ? together(cursors, (cursor) => pathInBackticks(value, cursor, key, closers)) : null;
	if (path) return path;
	const close = BRACKETS[key];
	if (close) return kinds.brackets ? together(cursors, (cursor) => openBracket(value, cursor, key, close)) : null;
	if (QUOTES.includes(key) || MARKDOWN.includes(key)) {
		if (!(MARKDOWN.includes(key) ? kinds.markdown : kinds.brackets)) return null;
		return together(cursors, (cursor) => typeSymbol(value, cursor, key, closers));
	}
	if (Object.values(BRACKETS).includes(key)) {
		if (!kinds.brackets) return null;
		// Block insert's closers go in together, so any one cursor speaks for all.
		if (!cursors.every((cursor) => closers.includes(span(cursor).from))) return null;
		return together(cursors, (cursor) => closeBracket(value, cursor, key));
	}
	if (WRAP_ONLY.includes(key)) return together(cursors, (cursor) => (cursor.anchor === cursor.focus ? null : wrapped(cursor, key, key, false)));
	return null;
}

/** Backspace between a pair, whoever typed its closer. Null to leave Backspace be. */
export function deletePair(value: string, cursors: readonly PairCursor[], kinds: PairKinds = EVERY_PAIR): PairChange | null {
	return together(cursors, (cursor) => {
		const { from, to } = span(cursor);
		if (from !== to || !from) return null;
		const before = value[from - 1]!;
		const close = (kinds.brackets ? BRACKETS[before] ?? (QUOTES.includes(before) ? before : null) : null)
			?? (kinds.markdown && MARKDOWN.includes(before) ? before : null);
		if (close === null || value[from] !== close) return null;
		return { parts: [{ from: from - 1, to: from + 1, text: "" }], anchor: from - 1, focus: from - 1 };
	});
}

type TextEdit = { from: number; to: number; length: number };

/** An offset after this edit, staying put at the edit's own spot. */
function mapLine(offset: number, { from, to, length }: TextEdit) {
	if (offset <= from) return offset;
	return offset >= to ? offset + length - (to - from) : from;
}

/** A closer lives as long as its own character, and moves with it. */
function mapCloser(closer: number, { from, to, length }: TextEdit) {
	if (closer < from) return closer;
	return closer >= to ? closer + length - (to - from) : null;
}

/** The closers a box put in itself, which are the only ones typing steps over. */
export class PairClosers {
	private offsets: number[] = [];
	private line = 0;

	get list(): readonly number[] { return this.offsets; }
	clear() { this.offsets = []; }
	private follow(changes: readonly TextEdit[]) {
		this.offsets = this.offsets.flatMap((closer) => {
			let at: number | null = closer;
			for (const change of changes) if (at !== null) at = mapCloser(at, change);
			return at === null ? [] : [at];
		});
	}
	/** The caret is here. On another line than before, every closer is forgotten. */
	arrived(value: string, caret: number) {
		const line = lineStart(value, caret);
		if (line !== this.line) this.offsets = [];
		this.line = line;
	}
	/** Text changed from outside, as dictation does, which is no move of the caret's. */
	mapped(changes: readonly TextEdit[], value: string, caret: number) {
		this.follow(changes);
		this.line = lineStart(value, caret);
	}
	/** Text changed, and the caret ended here. */
	edited(changes: readonly TextEdit[], value: string, caret: number) {
		const line = changes.reduce(mapLine, this.line);
		this.follow(changes);
		this.line = line;
		this.arrived(value, caret);
	}
	/** One of this module's own changes landed. */
	took(change: PairChange, value: string, caret: number) {
		this.offsets = this.offsets.filter((closer) => !change.passed.includes(closer));
		this.edited(change.edits, value, caret);
		this.offsets.push(...change.closers);
	}
}
