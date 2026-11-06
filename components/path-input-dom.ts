import katex from "katex";
import { parseFilePaths, quoteFilePath, revealedLiveKeys, type FilePathPart, type LiveFormat, type LiveLine, type LiveMath, type LiveRange } from "@/src/core";

/** Tokens store their complete source, not their abbreviated visual label. */
export const PATH_SOURCE_ATTRIBUTE = "data-file-path-source";
/** Presentation-only line box for the caret after a final model newline. */
export const PATH_CARET_ATTRIBUTE = "data-file-path-caret";
/** A rendered equation shown in place of its source, which stays in the DOM. */
export const LIVE_WIDGET_ATTRIBUTE = "data-lf-widget";
const LIVE_LINE_ATTRIBUTE = "data-lf-line";
export type TextSelection = { anchor: number; focus: number };
export type DOMPoint = { node: Node; offset: number };
type Segment = { text: string; start: DOMPoint; end: DOMPoint; node?: Text; token?: Element };

function childIndex(node: Node): number {
	return Array.prototype.indexOf.call(node.parentNode!.childNodes, node);
}

/** Browser editing can leave BR/block nodes; never use innerText (layout/whitespace dependent). */
function segments(root: HTMLElement): Segment[] {
	const result: Segment[] = [];
	function walk(node: Node) {
		if (node.nodeType === 3) {
			const text = node as Text;
			result.push({ text: text.data, start: { node, offset: 0 }, end: { node, offset: text.length }, node: text });
			return;
		}
		if (node.nodeType !== 1) return;
		const element = node as Element;
		if (element.hasAttribute(PATH_CARET_ATTRIBUTE) || element.hasAttribute(LIVE_WIDGET_ATTRIBUTE)) return;
		const raw = element.getAttribute(PATH_SOURCE_ATTRIBUTE);
		if (raw !== null) {
			const index = childIndex(node);
			result.push({ text: raw, start: { node: node.parentNode!, offset: index }, end: { node: node.parentNode!, offset: index + 1 }, token: element });
			return;
		}
		if (element.tagName === "BR") {
			// Chromium's lone BR is an empty editor/paragraph placeholder.
			if (node.parentNode?.childNodes.length === 1) return;
			const index = childIndex(node);
			result.push({ text: "\n", start: { node: node.parentNode!, offset: index }, end: { node: node.parentNode!, offset: index + 1 } });
			return;
		}
		Array.from(node.childNodes).forEach((child, index) => {
			const block = child.nodeType === 1 && /^(DIV|P)$/.test((child as Element).tagName);
			const previous = node.childNodes[index - 1];
			const previousBlock = previous?.nodeType === 1 && /^(DIV|P)$/.test((previous as Element).tagName);
			if (index > 0 && (block || previousBlock)) {
				result.push({ text: "\n", start: { node, offset: index }, end: { node, offset: index } });
			}
			walk(child);
		});
	}
	walk(root);
	return result;
}

export function readPathInput(root: HTMLElement): string {
	return segments(root).map((part) => part.text).join("");
}

/** Map a logical UTF-16 offset to a DOM boundary, snapping a chip interior atomically. */
export function pathInputPoint(root: HTMLElement, offset: number): DOMPoint {
	const parts = segments(root);
	const trailing = root.lastChild;
	if (trailing?.nodeType === 1 && (trailing as Element).hasAttribute(PATH_CARET_ATTRIBUTE)
		&& offset >= parts.reduce((length, part) => length + part.text.length, 0)) {
		// A text-node endpoint after its final newline has no line box in Chromium.
		// The boundary immediately before this BR is on the visible final line.
		return { node: root, offset: childIndex(trailing) };
	}
	let remaining = Math.max(0, offset);
	for (const [index, part] of parts.entries()) {
		if (remaining <= part.text.length) {
			// The offset after a line box's newline is the start of the next box.
			if (remaining > 0 && remaining === part.text.length && part.text.endsWith("\n") && index < parts.length - 1
				&& part.node?.parentElement?.closest(`[${LIVE_LINE_ATTRIBUTE}]`)) { remaining = 0; continue; }
			if (part.node) return { node: part.node, offset: remaining };
			return remaining <= part.text.length / 2 ? part.start : part.end;
		}
		remaining -= part.text.length;
	}
	return { node: root, offset: root.childNodes.length };
}

/** Works without Range: useful in DOM test environments as well as real Selection. */
export function pathInputOffset(root: HTMLElement, node: Node, offset: number): number | null {
	if (node !== root && !root.contains(node)) return null;
	const widget = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(`[${LIVE_WIDGET_ATTRIBUTE}]`);
	if (widget) { node = widget.parentNode!; offset = childIndex(widget); }
	let total = 0;
	for (const part of segments(root)) {
		if (part.node === node) return total + Math.min(Math.max(0, offset), part.text.length);
		if (part.token?.contains(node)) {
			// A mouse/programmatic selection can end inside a noneditable label.
			// Keep distinct interior endpoints so atomicPathRange expands copy/cut
			// to the complete source instead of leaking the abbreviated filename.
			let visualOffset = node.nodeType === 3 ? offset : Array.from(node.childNodes).slice(0, offset).reduce((length, child) => length + (child.textContent?.length ?? 0), 0);
			let cursor = node;
			while (cursor !== part.token) {
				let sibling = cursor.previousSibling;
				while (sibling) { visualOffset += sibling.textContent?.length ?? 0; sibling = sibling.previousSibling; }
				cursor = cursor.parentNode!;
			}
			const visualLength = part.token.textContent?.length ?? 0;
			return total + (visualLength ? Math.round(Math.min(visualLength, visualOffset) / visualLength * part.text.length) : 0);
		}
		if (part.start.node === node && part.start.offset >= offset) return total;
		if (part.end.node === node && part.end.offset <= offset) {
			total += part.text.length;
			continue;
		}
		// A boundary in an ancestor is before/after every descendant segment.
		let ancestor: Node = part.node ?? part.token ?? part.start.node;
		while (ancestor.parentNode && ancestor.parentNode !== node) ancestor = ancestor.parentNode;
		if (ancestor.parentNode === node && childIndex(ancestor) >= offset) return total;
		total += part.text.length;
	}
	return total;
}

/** Validate a browser beforeinput StaticRange before projecting its exact endpoints. */
export function pathInputStaticRange(root: HTMLElement, range: Pick<StaticRange, "startContainer" | "startOffset" | "endContainer" | "endOffset">): TextSelection | null {
	function valid(node: Node, offset: number) {
		return (node === root || root.contains(node)) && Number.isInteger(offset) && offset >= 0
			&& offset <= (node.nodeType === 3 ? (node as Text).length : node.childNodes.length);
	}
	if (!valid(range.startContainer, range.startOffset) || !valid(range.endContainer, range.endOffset)) return null;
	const anchor = pathInputOffset(root, range.startContainer, range.startOffset);
	const focus = pathInputOffset(root, range.endContainer, range.endOffset);
	return anchor === null || focus === null || anchor >= focus ? null : { anchor, focus };
}

export function readPathSelection(root: HTMLElement): TextSelection | null {
	const selection = root.ownerDocument.getSelection?.();
	if (!selection?.anchorNode || !selection.focusNode) return null;
	const anchor = pathInputOffset(root, selection.anchorNode, selection.anchorOffset);
	const focus = pathInputOffset(root, selection.focusNode, selection.focusOffset);
	return anchor === null || focus === null ? null : { anchor, focus };
}

export function restorePathSelection(root: HTMLElement, selection: TextSelection): void {
	const browserSelection = root.ownerDocument.getSelection?.();
	if (!browserSelection) return;
	const anchor = pathInputPoint(root, selection.anchor);
	const focus = pathInputPoint(root, selection.focus);
	browserSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

type PathPart = Extract<FilePathPart, { kind: "path" }>;
type ChipHost = { host: HTMLElement; path: string };

function chipHost(document: Document, part: PathPart): ChipHost {
	const host = document.createElement("span");
	host.contentEditable = "false";
	host.setAttribute("contenteditable", "false");
	host.setAttribute(PATH_SOURCE_ATTRIBUTE, part.text);
	return { host, path: part.path };
}

/** Swap in a drawn draft, with the caret boxes every drawing needs. */
function commitDrawing(root: HTMLElement, value: string, fragment: DocumentFragment): void {
	const document = root.ownerDocument;
	// Empty boundary text nodes allow a caret immediately before/after an atomic chip.
	if (!fragment.firstChild || fragment.firstChild.nodeType !== 3) fragment.prepend(document.createTextNode(""));
	if (fragment.lastChild?.nodeType !== 3) fragment.append(document.createTextNode(""));
	if (value.endsWith("\n")) {
		// pre-wrap alone collapses the final empty line. This BR supplies its
		// height/caret without adding a second newline to the stored source.
		const caret = document.createElement("br");
		caret.setAttribute(PATH_CARET_ATTRIBUTE, "");
		caret.setAttribute("aria-hidden", "true");
		fragment.append(caret);
	}
	root.replaceChildren(fragment);
	root.dataset.empty = value.length === 0 ? "true" : "false";
}

/** Returns portal hosts. React owns only their visual contents, never the editable tree. */
export function renderPathInput(root: HTMLElement, value: string): ChipHost[] {
	const document = root.ownerDocument;
	const fragment = document.createDocumentFragment();
	const chips: ChipHost[] = [];
	for (const part of parseFilePaths(value)) {
		if (part.kind === "text") {
			fragment.append(document.createTextNode(part.text));
		} else {
			const chip = chipHost(document, part);
			fragment.append(chip.host);
			chips.push(chip);
		}
	}
	commitDrawing(root, value, fragment);
	return chips;
}

const equationCache = new Map<string, string>();
/** Same fallback as the transcript's rehype-katex: bad TeX shows muted, never throws. */
function equationHtml(math: LiveMath): string {
	const key = `${math.display ? "d" : "i"}:${math.tex}`;
	let html = equationCache.get(key);
	if (html === undefined) {
		html = katex.renderToString(math.tex, { displayMode: math.display, throwOnError: false, strict: "ignore", errorColor: "var(--color-muted-foreground)" });
		if (equationCache.size >= 200) equationCache.delete(equationCache.keys().next().value!);
		equationCache.set(key, html);
	}
	return html;
}

export type LiveView = { format: LiveFormat; elements: Map<string, Element[]>; previews: Map<string, Element>; shown: Set<string> };

function lineBox(document: Document, line: LiveLine): HTMLElement {
	const box = document.createElement("span");
	box.className = "lh-lf-line";
	box.setAttribute(LIVE_LINE_ATTRIBUTE, "");
	if (line.heading) box.setAttribute("data-heading", String(line.heading));
	if (line.quote) box.setAttribute("data-quote", String(line.quote));
	if (line.list) {
		box.setAttribute("data-list", line.list);
		box.style.setProperty("--lh-lf-depth", String(line.depth));
	}
	return box;
}

function equationWidget(document: Document, math: LiveMath, index: number): HTMLElement {
	const widget = document.createElement("span");
	widget.className = math.display ? "lh-lf-math lh-lf-display" : "lh-lf-math";
	widget.contentEditable = "false";
	widget.setAttribute("contenteditable", "false");
	widget.setAttribute(LIVE_WIDGET_ATTRIBUTE, String(index));
	widget.innerHTML = equationHtml(math);
	return widget;
}

/** Draw a draft with formatting. Every source character stays in the DOM, so a
 * selection never has to move when symbols are shown or hidden. */
export function renderLiveInput(root: HTMLElement, value: string, format: LiveFormat): { chips: ChipHost[]; view: LiveView } {
	const document = root.ownerDocument;
	const fragment = document.createDocumentFragment();
	const chips: ChipHost[] = [];
	const elements = new Map<string, Element[]>();
	const previews = new Map<string, Element>();
	const track = (key: string, element: Element) => {
		const list = elements.get(key);
		if (list) list.push(element); else elements.set(key, [element]);
	};
	const paths = new Map<number, PathPart>();
	for (const part of parseFilePaths(value)) if (part.kind === "path") paths.set(part.start, part);

	const cuts = new Set([0, value.length]);
	const cut = (range: LiveRange) => { cuts.add(range.start); cuts.add(range.end); };
	for (const path of paths.values()) cut(path);
	for (const item of format.items) {
		cut(item);
		if (item.kind === "span") item.markers.forEach(cut);
	}
	for (const line of format.lines) { cut(line); line.markers.forEach(cut); }
	const stops = [...cuts].sort((a, b) => a - b);

	const within = (ranges: LiveRange[], offset: number) => ranges.some((range) => offset >= range.start && offset < range.end);
	let container: ParentNode & Node = fragment;
	let openLine = -1, nextLine = 0, nextItem = 0;
	let active: number[] = [];
	for (let stop = 0; stop + 1 < stops.length; stop++) {
		const start = stops[stop]!, end = stops[stop + 1]!;
		while (nextLine < format.lines.length && format.lines[nextLine]!.end <= start) nextLine++;
		const line = format.lines[nextLine];
		const lineIndex = line && start >= line.start ? nextLine : -1;
		if (lineIndex !== openLine) {
			openLine = lineIndex;
			if (lineIndex < 0) container = fragment;
			else {
				const box = lineBox(document, line!);
				track(`l${lineIndex}`, box);
				fragment.append(box);
				container = box;
			}
		}
		active = active.filter((index) => format.items[index]!.end > start);
		while (nextItem < format.items.length && format.items[nextItem]!.start <= start) active.push(nextItem++);

		const path = paths.get(start);
		if (path) {
			const chip = chipHost(document, path);
			container.append(chip.host);
			chips.push(chip);
			continue;
		}
		const classes: string[] = [];
		let key: string | null = null;
		let below: HTMLElement | null = null;
		for (const index of active) {
			const item = format.items[index]!;
			if (item.kind === "math") {
				key = `i${index}`;
				classes.push("lh-lf-hide", "lh-lf-source");
				// A block equation stays on screen below its source, as the preview
				// while it is edited. An inline one swaps with its source instead.
				if (item.display && end === item.end) {
					below = equationWidget(document, item, index);
					previews.set(key, below);
				} else if (!item.display && start === item.start) {
					const widget = equationWidget(document, item, index);
					track(key, widget);
					container.append(widget);
				}
			} else if (within(item.markers, start)) {
				key = `i${index}`;
				classes.push("lh-lf-hide", "lh-lf-marker");
			} else classes.push(`lh-lf-${item.style}`);
		}
		if (lineIndex >= 0 && within(line!.markers, start)) {
			key = `l${lineIndex}`;
			classes.push("lh-lf-hide", "lh-lf-marker");
		}
		const text = document.createTextNode(value.slice(start, end));
		if (classes.length) {
			const span = document.createElement("span");
			span.className = classes.join(" ");
			span.append(text);
			if (key) track(key, span);
			container.append(span);
		} else container.append(text);
		if (below) {
			// Without a real line end here the browser draws the caret at the end
			// of the source beside the preview. Not text: segments() skips it.
			const lineEnd = document.createElement("br");
			lineEnd.setAttribute(PATH_CARET_ATTRIBUTE, "");
			lineEnd.setAttribute("aria-hidden", "true");
			lineEnd.className = "lh-lf-hide";
			if (key) track(key, lineEnd);
			container.append(lineEnd, below);
		}
	}
	commitDrawing(root, value, fragment);
	return { chips, view: { format, elements, previews, shown: new Set() } };
}

/** Show the source of what the selection touches. Toggles attributes only:
 * the DOM and the browser's selection stay exactly as they were. */
export function revealLiveInput(view: LiveView, selection: TextSelection | null): void {
	const next = revealedLiveKeys(view.format, selection);
	// A hidden noneditable widget still costs a key press to cross, so it only
	// stays noneditable while it is on screen.
	const toggle = (element: Element, show: boolean) => {
		element.toggleAttribute("data-show", show);
		if (!element.hasAttribute(LIVE_WIDGET_ATTRIBUTE)) return;
		if (show) element.removeAttribute("contenteditable");
		else element.setAttribute("contenteditable", "false");
	};
	for (const key of view.shown) if (!next.has(key)) for (const element of view.elements.get(key) ?? []) toggle(element, false);
	for (const key of next) if (!view.shown.has(key)) for (const element of view.elements.get(key) ?? []) toggle(element, true);
	view.shown = next;
}

const blockEquations = (view: LiveView) => view.format.items.filter((item): item is LiveMath => item.kind === "math" && item.display);

/** True at a block equation's end. The DOM has two spots for that one offset,
 * either side of the preview, and only the one in the source is usable. */
export function atPreviewEnd(view: LiveView, offset: number): boolean {
	return blockEquations(view).some((math) => math.end === offset);
}

/** Where an arrow key goes around a block equation when the browser would get
 * it wrong: stepping in would skip the hidden source, and stepping out would
 * stop beside the preview. Null leaves the key to the browser. */
export function previewArrowTarget(view: LiveView, value: string, offset: number, key: string): number | null {
	for (const math of blockEquations(view)) {
		if (key === "ArrowRight" && offset === math.start - 1) return math.start;
		if ((key === "ArrowRight" || key === "ArrowDown") && offset === math.end) {
			return Math.min(value.length, offset + (/[\ud800-\udbff]/.test(value[offset] ?? "") ? 2 : 1));
		}
	}
	return null;
}

/** The browser only scrolls the caret into view, so a preview under the last
 * line of a tall draft would stay clipped. Never scrolls the source out of view. */
export function keepPreviewInView(root: HTMLElement, view: LiveView): void {
	for (const key of view.shown) {
		const preview = view.previews.get(key);
		if (!preview) continue;
		const box = root.getBoundingClientRect(), bottom = preview.getBoundingClientRect().bottom;
		const source = view.elements.get(key)?.[0]?.getBoundingClientRect().top ?? bottom;
		const overflow = Math.min(bottom - box.bottom, source - box.top);
		if (overflow > 0) root.scrollTop += overflow;
	}
}

/** A browser treats both sides of hidden symbols as one spot and keeps the
 * inner one, so End on a line ending in bold would type into the bold. A caret
 * arriving against an item's hidden symbols belongs outside them. */
export function settleLiveCaret(view: LiveView, offset: number): number {
	let next = offset;
	for (let moved = true; moved;) {
		moved = false;
		view.format.items.forEach((item, index) => {
			if (item.kind !== "span" || item.markers.length !== 2 || view.shown.has(`i${index}`)) return;
			const [open, close] = item.markers as [LiveRange, LiveRange];
			if (next === open.end) { next = open.start; moved = true; }
			else if (next === close.start) { next = close.end; moved = true; }
		});
	}
	return next;
}

export function clampPathSelection(value: string, selection: TextSelection): TextSelection {
	const clamp = (offset: number) => Math.min(value.length, Math.max(0, offset));
	return { anchor: clamp(selection.anchor), focus: clamp(selection.focus) };
}

/** A selection intersecting any part of a chip edits/copies that complete source. */
export function atomicPathRange(value: string, selection: TextSelection): { start: number; end: number } {
	const clamped = clampPathSelection(value, selection);
	let start = Math.min(clamped.anchor, clamped.focus);
	let end = Math.max(clamped.anchor, clamped.focus);
	for (const part of parseFilePaths(value)) {
		if (part.kind !== "path") continue;
		if (start > part.start && start < part.end) start = part.start;
		if (end > part.start && end < part.end) end = part.end;
	}
	return { start, end };
}

export function replacePathSelection(value: string, selection: TextSelection, text: string) {
	const { start, end } = atomicPathRange(value, selection);
	return { value: value.slice(0, start) + text + value.slice(end), selection: { anchor: start + text.length, focus: start + text.length } };
}

export function insertFilePaths(value: string, selection: TextSelection, paths: string[]) {
	const { start, end } = atomicPathRange(value, selection);
	const text = paths.map(quoteFilePath).join(" ");
	if (!text) return { value, selection };
	const before = start > 0 && !/\s/.test(value[start - 1]!) ? " " : "";
	const after = end < value.length && !/\s/.test(value[end]!) ? " " : "";
	return replacePathSelection(value, selection, before + text + after);
}

export function adjacentPathRange(value: string, selection: TextSelection, direction: "backward" | "forward"): TextSelection | null {
	if (selection.anchor !== selection.focus) return selection;
	const caret = selection.focus;
	for (const part of parseFilePaths(value)) {
		if (part.kind === "path" && (direction === "backward" ? caret > part.start && caret <= part.end : caret >= part.start && caret < part.end)) {
			return { anchor: part.start, focus: part.end };
		}
	}
	return null;
}

export type PathEditSnapshot = { value: string; selection: TextSelection };

/** Match the text input value sanitization algorithm: remove CR/LF, not spaces. */
export function normalizePathInputValue(value: string, singleLine: boolean): string {
	return singleLine ? value.replace(/[\r\n]/g, "") : value;
}

export function normalizePathEdit(snapshot: PathEditSnapshot, singleLine: boolean): PathEditSnapshot {
	if (!singleLine) return snapshot;
	const selection = clampPathSelection(snapshot.value, snapshot.selection);
	return {
		value: normalizePathInputValue(snapshot.value, true),
		selection: {
			anchor: normalizePathInputValue(snapshot.value.slice(0, selection.anchor), true).length,
			focus: normalizePathInputValue(snapshot.value.slice(0, selection.focus), true).length,
		},
	};
}

/** Independent of the browser's DOM undo stack (normalization replaces native nodes). */
export class PathInputHistory {
	private undoStack: PathEditSnapshot[] = [];
	private redoStack: PathEditSnapshot[] = [];
	push(snapshot: PathEditSnapshot) {
		this.undoStack.push({ value: snapshot.value, selection: { ...snapshot.selection } });
		this.redoStack = [];
	}
	reset() { this.undoStack = []; this.redoStack = []; }
	undo(current: PathEditSnapshot): PathEditSnapshot | null {
		const previous = this.undoStack.pop();
		if (!previous) return null;
		this.redoStack.push(current);
		return previous;
	}
	redo(current: PathEditSnapshot): PathEditSnapshot | null {
		const next = this.redoStack.pop();
		if (!next) return null;
		this.undoStack.push(current);
		return next;
	}
}
