/** Where formatting sits in a learner draft, as source offsets. The draft is
 * never rewritten: this only tells the editor what to style and hide. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFilePaths } from "./file-paths.ts";
import { readMathSources } from "./math-delims.ts";

export type LiveRange = { start: number; end: number };
export type LiveStyle = "strong" | "emphasis" | "delete" | "code" | "link";
export type LiveSpan = LiveRange & { kind: "span"; style: LiveStyle; markers: LiveRange[] };
export type LiveMath = LiveRange & { kind: "math"; tex: string; display: boolean; caret: number };
export type LiveItem = LiveSpan | LiveMath;
/** `end` is past the line's newline; `textEnd` stops before it. */
export type LiveLine = LiveRange & { textEnd: number; heading: number; quote: number; list: "" | "bullet" | "ordered"; depth: number; markers: LiveRange[] };
export type LiveFormat = { items: LiveItem[]; lines: LiveLine[] };
export type LiveFormatOptions = { math: boolean };
export type LiveSelection = { anchor: number; focus: number };

/** Formatting a draft runs on every keystroke, and its cost follows how much
 * formatting it holds: 5,000 well-formatted characters take about 45ms a key in
 * Chromium, 19,000 take 355ms. Past this a draft stays plain text. */
export const LIVE_FORMAT_LIMIT = 5_000;
const MASK = "";
const EMPTY: LiveFormat = { items: [], lines: [] };

type MdNode = {
	type: string; depth?: number; ordered?: boolean | null;
	position?: { start: { offset?: number }; end: { offset?: number } };
	children?: MdNode[];
};
const startOf = (node: MdNode) => node.position!.start.offset!;
const endOf = (node: MdNode) => node.position!.end.offset!;
const overlaps = (a: LiveRange, b: LiveRange) => a.start < b.end && b.start < a.end;

/** Hide math from the Markdown parser without moving any offset. */
function maskRanges(text: string, ranges: LiveRange[]): string {
	let out = "", at = 0;
	for (const range of ranges) {
		out += text.slice(at, range.start) + text.slice(range.start, range.end).replace(/[^\n]/g, MASK);
		at = range.end;
	}
	return out + text.slice(at);
}

export function readLiveFormat(text: string, options: LiveFormatOptions): LiveFormat {
	if (!text || text.length > LIVE_FORMAT_LIMIT) return EMPTY;
	const chips: LiveRange[] = parseFilePaths(text).filter(part => part.kind === "path");
	const sources = options.math ? readMathSources(text).filter(source => !chips.some(chip => overlaps(source, chip))) : [];
	const tree = fromMarkdown(maskRanges(text, sources), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MdNode;

	const lineStarts = [0];
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
	const lineAt = (offset: number) => {
		let low = 0, high = lineStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (lineStarts[middle]! <= offset) low = middle; else high = middle - 1;
		}
		return low;
	};
	const formatted = new Map<number, LiveLine & { cursor: number }>();
	const line = (index: number) => {
		let found = formatted.get(index);
		if (!found) {
			const start = lineStarts[index]!;
			const next = lineStarts[index + 1];
			found = { start, end: next ?? text.length, textEnd: next === undefined ? text.length : next - 1, heading: 0, quote: 0, list: "", depth: 0, markers: [], cursor: start };
			formatted.set(index, found);
		}
		return found;
	};

	const spans: LiveSpan[] = [];
	const literal: LiveRange[] = [];
	function walk(node: MdNode, listDepth: number, ordered: boolean) {
		const start = node.position ? startOf(node) : 0, end = node.position ? endOf(node) : 0;
		switch (node.type) {
			case "code": case "table": case "html": case "image":
				literal.push({ start, end });
				return;
			case "strong": case "emphasis": case "delete": {
				const first = node.children?.[0], last = node.children?.at(-1);
				if (first && last) spans.push({ kind: "span", start, end, style: node.type as LiveStyle,
					markers: [{ start, end: startOf(first) }, { start: endOf(last), end }] });
				break;
			}
			case "inlineCode": {
				if (chips.some(chip => overlaps(chip, { start, end }))) return;
				const run = /^`+/.exec(text.slice(start, end))?.[0].length ?? 0;
				if (run) spans.push({ kind: "span", start, end, style: "code", markers: [{ start, end: start + run }, { start: end - run, end }] });
				return;
			}
			case "link": {
				const last = node.children?.at(-1);
				const inline = last && text[start] === "[" && text.startsWith("](", endOf(last));
				spans.push({ kind: "span", start, end, style: "link",
					markers: inline ? [{ start, end: start + 1 }, { start: endOf(last), end }] : [] });
				break;
			}
			case "heading": {
				const first = lineAt(start);
				const atx = /^#{1,6}(?:[ \t]+|$)/.exec(text.slice(start, line(first).textEnd));
				if (atx) {
					const current = line(first);
					current.heading = node.depth ?? 1;
					current.markers.push({ start, end: start + atx[0].length });
				} else for (let index = first; index < lineAt(end); index++) line(index).heading = node.depth ?? 1;
				break;
			}
			case "blockquote":
				for (let index = lineAt(start); index <= lineAt(end); index++) {
					const current = line(index);
					current.quote++;
					const prefix = /^ {0,3}> ?/.exec(text.slice(current.cursor, current.textEnd));
					if (prefix) {
						current.markers.push({ start: current.cursor, end: current.cursor + prefix[0].length });
						current.cursor += prefix[0].length;
					}
				}
				break;
			case "list":
				for (const child of node.children ?? []) walk(child, listDepth + 1, Boolean(node.ordered));
				return;
			case "listItem": {
				const current = line(lineAt(start));
				const marker = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(text.slice(start, current.textEnd));
				if (marker) {
					current.list = ordered ? "ordered" : "bullet";
					current.depth = listDepth;
					if (current.cursor < start) current.markers.push({ start: current.cursor, end: start });
					if (!ordered) current.markers.push({ start, end: start + marker[0].length });
					current.cursor = start + marker[0].length;
				}
				break;
			}
		}
		for (const child of node.children ?? []) walk(child, listDepth, ordered);
	}
	walk(tree, 0, false);

	const lines = [...formatted.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
		.filter(value => value.heading || value.quote || value.list)
		.map(({ cursor: _cursor, ...value }) => ({ ...value, markers: value.markers.filter(marker => marker.start < marker.end) }));
	// A bordered or indented line is its own box, so an equation cannot span one.
	const crossesLine = (range: LiveRange) => text.slice(range.start, range.end).includes("\n")
		&& lines.some(value => (value.start > range.start && value.start < range.end) || (value.end > range.start && value.end < range.end));
	const maths: LiveMath[] = sources
		.filter(source => !crossesLine(source) && !literal.some(range => overlaps(range, source)))
		.map(source => ({ kind: "math", start: source.start, end: source.end, tex: source.tex, display: source.display, caret: source.bodyEnd }));
	return { items: [...spans, ...maths].sort((a, b) => a.start - b.start || b.end - a.end), lines };
}

/** The items and lines a selection touches, including its edges, as render keys. */
export function revealedLiveKeys(format: LiveFormat, selection: LiveSelection | null): Set<string> {
	const keys = new Set<string>();
	if (!selection) return keys;
	const from = Math.min(selection.anchor, selection.focus), to = Math.max(selection.anchor, selection.focus);
	format.items.forEach((item, index) => { if (from <= item.end && to >= item.start) keys.add(`i${index}`); });
	format.lines.forEach((value, index) => { if (from <= value.textEnd && to >= value.start) keys.add(`l${index}`); });
	return keys;
}
