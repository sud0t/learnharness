"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { FilePathChip } from "./file-path-chip";
import { cn } from "../lib/utils";
import { defaultSnippets, EVERY_PAIR, readLiveFormat, type LatexSnippetSet, type LiveFormatOptions, type PairKinds } from "../src/core";
import {
	adjacentPathRange, atomicPathRange, atPreviewEnd, clampPathSelection, insertFilePaths,
	normalizePathEdit, normalizePathInputValue, pathInputStaticRange, PathInputHistory, readPathInput, readPathSelection, keepPreviewInView, pathInputPoint, previewArrowTarget, renderLiveInput, renderPathInput,
	replacePathSelection, restorePathSelection, revealLiveInput, settleLiveCaret, keepCaretInView, keepSelectionEndInView, selectionEndInView, LIVE_WIDGET_ATTRIBUTE,
	type LiveView, type PathEditSnapshot, type TextSelection,
} from "./path-input-dom";
import { attachPairs, type PairBox } from "./path-input-pairs";
import { attachSnippets, type SnippetBox } from "./path-input-snippets";
import { attachVim, type TextEdit, type VimBox } from "./path-input-vim";

export const INSERT_FILE_PATHS_EVENT = "lh:insert-file-paths";
const DOUBLE_CLICK_MS = 250;
export type PathInputProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML" | "defaultValue" | "onChange"> & {
	value: string;
	onValueChange: (value: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	defaultDropTarget?: boolean;
	/** Native text-input semantics: strip CR/LF and leave Enter to the caller. */
	singleLine?: boolean;
	/** Format the draft in place, hiding Markdown symbols away from the caret. */
	liveFormat?: LiveFormatOptions | null;
	/** Vim keys, for every box but a single-line one. */
	vim?: boolean;
	/** Latex Suite's snippets and tabstops, for every box but a single-line one. */
	snippets?: boolean;
	/** The learner's own snippets. The shipped set if unsaid. */
	snippetSet?: LatexSnippetSet;
	/** Closing pairs as you type, for every box but a single-line one. True is every kind. */
	pairs?: boolean | PairKinds;
};

type ChipHost = { host: HTMLElement; path: string };
type Controller = {
	external: (value: string) => void;
	remember: () => void;
	repaint: () => void;
	setVim: (on: boolean) => void;
	setSnippets: (on: boolean) => void;
	setPairs: (on: boolean) => void;
	chipsDrawn: () => void;
};

/**
 * A controlled plaintext editor. Only the source string is state; chips are atomic
 * views of it. React never reconciles the editable DOM after a native mutation.
 */
export const PathInput = React.forwardRef<HTMLDivElement, PathInputProps>(function PathInput({
	value, onValueChange, placeholder, autoFocus, defaultDropTarget = false, singleLine = false, liveFormat = null, vim: vimKeys = false, snippets: snippetKeys = false, snippetSet, pairs: pairKeys = false, className,
	onKeyDown, onFocus, onBlur, onInput, onPaste, onCopy, onCut,
	onCompositionStart, onCompositionEnd, ...props
}, forwardedRef) {
	const rootRef = React.useRef<HTMLDivElement>(null);
	const controllerRef = React.useRef<Controller | null>(null);
	const pairKinds = pairKeys === true ? EVERY_PAIR : pairKeys || null;
	const callbacks = React.useRef({ onValueChange, singleLine, liveFormat, snippetSet, pairKinds });
	const composing = React.useRef(false);
	const [chips, setChips] = React.useState<ChipHost[]>([]);
	// Keep this text child immutable: SSR/hydration gets the complete draft,
	// while subsequent React renders leave the browser-owned editable DOM alone.
	const initial = React.useRef({ value: normalizePathInputValue(value, singleLine), autoFocus, singleLine });

	React.useImperativeHandle(forwardedRef, () => rootRef.current!, []);
	React.useLayoutEffect(() => { callbacks.current = { onValueChange, singleLine, liveFormat, snippetSet, pairKinds }; }, [onValueChange, singleLine, liveFormat, snippetSet, pairKinds]);

	React.useLayoutEffect(() => {
		const root = rootRef.current!;
		const document = root.ownerDocument;
		let current = normalizePathInputValue(initial.current.value, initial.current.singleLine);
		let saved: TextSelection = { anchor: current.length, focus: current.length };
		let beforeEdit: PathEditSnapshot | null = null;
		let compositionStart: PathEditSnapshot | null = null;
		let pendingExternal: string | null = null;
		let pendingPaths: string[] = [];
		let pendingPaste: string[] = [];
		let mounted = true;
		let view: LiveView | null = null;
		let pressed = false;
		let clickHold: ReturnType<typeof setTimeout> | null = null;
		/** Redrawing while blurred removes the nodes the browser's selection was in. */
		let dropped = false;
		const history = new PathInputHistory();
		let vim: VimBox | null = null;
		let snippets: SnippetBox | null = null;
		let pairs: PairBox | null = null;
		/** Composing in a box that takes no typing: the text must not stay. */
		let discardComposition = false;
		/** Chips fill in when React commits them, which makes their lines taller,
		 * so a caret scrolled to before that has to be scrolled to again. */
		let measureAfterChips = false;

		function remember() {
			if (document.activeElement !== root) return;
			const selection = readPathSelection(root);
			if (selection) saved = selection;
		}
		function snapshot(): PathEditSnapshot {
			return { value: current, selection: { ...saved } };
		}
		/** True when symbols appeared or vanished, which moves the text. */
		function reveal() {
			if (!view) return false;
			const focused = document.activeElement === root;
			const moved = revealLiveInput(view, focused ? vim?.block() ?? saved : null);
			keepPreviewInView(root, view, focused ? saved.focus : null);
			return moved;
		}
		/** Set the selection from script, which unlike a browser edit does not scroll. */
		function place() {
			restorePathSelection(root, saved);
			keepCaretInView(root, saved.focus);
		}
		function paint(selection: TextSelection, restore: boolean) {
			const live = callbacks.current.liveFormat;
			const format = live && !callbacks.current.singleLine ? readLiveFormat(current, live) : null;
			saved = clampPathSelection(current, selection);
			let chipHosts: ChipHost[];
			if (format) {
				const drawn = renderLiveInput(root, current, format);
				view = drawn.view;
				chipHosts = drawn.chips;
				setChips(chipHosts);
				reveal();
			} else {
				view = null;
				chipHosts = renderPathInput(root, current);
				setChips(chipHosts);
			}
			measureAfterChips = restore && chipHosts.length > 0;
			if (restore) place(); else dropped = true;
			vim?.painted();
			snippets?.painted();
		}
		/** Without this, focusing reads the dropped selection as the start of the text. */
		function focused() {
			if (dropped) {
				dropped = false;
				restorePathSelection(root, saved);
				// Focusing from script scrolled to that start. A press leaves the
				// box where the learner is looking, and sets its own caret next.
				if (!pressed) keepCaretInView(root, saved.focus);
			}
			selectionChanged();
		}
		function change(next: PathEditSnapshot, record = true, before = snapshot(), notify = true, edits?: readonly TextEdit[]) {
			next = normalizePathEdit(next, callbacks.current.singleLine);
			if (next.value === current) { paint(next.selection, document.activeElement === root); return; }
			if (record) {
				history.push(before);
				next = snippets?.edited(before, next, edits) ?? next;
			}
			pairs?.edited(before, next, edits);
			current = next.value;
			paint(next.selection, document.activeElement === root);
			vim?.noted(record);
			if (notify) callbacks.current.onValueChange(current);
		}
		function replace(text: string) {
			remember();
			change(replacePathSelection(current, saved, text));
		}
		function travel(direction: "undo" | "redo") {
			remember();
			const next = history[direction](snapshot());
			if (next) {
				snippets?.travelled(direction, next.value);
				change(next, false);
			}
			vim?.resumeGroup();
		}
		function stage(paths: string[]) {
			if (composing.current) { pendingPaths.push(...paths); return; }
			remember();
			// Global drop may have moved focus: saved selection is still authoritative.
			let next: PathEditSnapshot;
			try { next = insertFilePaths(current, saved, paths); }
			catch { return; } // Invalid event payloads never mutate learner text.
			change(next);
			root.focus();
			place();
		}
		function select(selection: TextSelection) {
			saved = selection;
			if (document.activeElement === root) { reveal(); place(); } else dropped = true;
		}
		function insertEvent(event: Event) {
			const paths: unknown = (event as CustomEvent<unknown>).detail;
			if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) stage(paths);
		}
		function beforeInput(event: InputEvent) {
			if (composing.current || event.isComposing) return;
			if (vim?.blocksInput(event)) { event.preventDefault(); return; }
			remember();
			beforeEdit = snapshot();
			// This is where typed text arrives, with the edit's snapshot taken and
			// nothing applied yet. Snippets go first, so that in math they win.
			if (snippets?.typed(event) || pairs?.typed(event)) { event.preventDefault(); beforeEdit = null; return; }
			if (vim?.multiInput(event)) { event.preventDefault(); return; }
			if (view && event.inputType === "insertText" && event.data && saved.anchor !== saved.focus) {
				// Hidden symbols inside a selection must go too: the model owns this.
				event.preventDefault();
				change(replacePathSelection(current, saved, event.data));
			} else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
				event.preventDefault();
				travel(event.inputType === "historyUndo" ? "undo" : "redo");
			} else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
				event.preventDefault();
				if (!callbacks.current.singleLine) replace("\n");
			} else if (event.inputType.startsWith("format") || event.inputType === "insertHTML") {
				event.preventDefault();
			} else if (event.inputType === "deleteByCut") {
				// The cut handler owns both the full-source clipboard and deletion.
				// Never perform a second deletion if a browser also sends beforeinput.
				event.preventDefault();
			} else if (/^delete(?:(?:Word|SoftLine|HardLine)(?:Backward|Forward)|EntireSoftLine)$/.test(event.inputType)) {
				// Modifier keys have platform-specific word/visual-line semantics.
				// Only the browser knows that extent; never substitute an adjacent chip.
				let targets: StaticRange[] = [];
				try { targets = event.getTargetRanges?.() ?? []; } catch { /* Native fallback below. */ }
				const range = targets.length === 1 ? pathInputStaticRange(root, targets[0]!) : null;
				if (range && event.cancelable) {
					event.preventDefault();
					// replacePathSelection expands any intersected chip atomically.
					change(replacePathSelection(current, range, ""));
				}
				// Missing/invalid/non-single targets: native edit + input projection owns it.
			} else if (event.inputType.startsWith("delete")) {
				const backward = event.inputType.includes("Backward");
				const range = adjacentPathRange(current, saved, backward ? "backward" : "forward") ?? (view ? liveDeleteRange(event, backward) : null);
				if (range) {
					event.preventDefault();
					change(replacePathSelection(current, range, ""));
				}
			}
		}
		/** Formatted text never deletes natively: Chromium prunes hidden symbols
		 * next to a text node it empties. Its target range is still the truth for
		 * how much one press removes, such as a whole emoji. */
		function liveDeleteRange(event: InputEvent, backward: boolean): TextSelection | null {
			let targets: StaticRange[] = [];
			try { targets = event.getTargetRanges?.() ?? []; } catch { /* Fall through. */ }
			const range = targets.length === 1 ? pathInputStaticRange(root, targets[0]!) : null;
			if (range) return range;
			const at = saved.focus;
			if (backward ? at === 0 : at === current.length) return null;
			const from = backward ? at - (/[\udc00-\udfff]/.test(current[at - 1]!) ? 2 : 1) : at;
			const to = backward ? at : at + (/[\ud800-\udbff]/.test(current[at]!) ? 2 : 1);
			return { anchor: from, focus: to };
		}
		function input() {
			if (composing.current) {
				root.dataset.empty = normalizePathInputValue(readPathInput(root), callbacks.current.singleLine).length === 0 ? "true" : "false";
				return;
			}
			const nextValue = readPathInput(root);
			const selection = readPathSelection(root) ?? saved;
			const previous = beforeEdit ?? snapshot();
			beforeEdit = null;
			change({ value: nextValue, selection }, true, previous);
		}
		function keyDown(event: KeyboardEvent) {
			if (composing.current || event.isComposing || event.keyCode === 229) return;
			// Shift+Delete is native Cut on Windows/Linux, not forward deletion.
			// Let the browser dispatch cut so our clipboard handler can own it.
			if (event.key === "Delete" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return;
			remember();
			// selectionchange is asynchronous; a repeating key must not outrun it.
			if (view && !pressed) releaseHold();
			// Ahead of vim: Tab between a snippet's stops, and Backspace in an empty
			// pair, are not vim's to see.
			if (snippets?.keyDown(event) || pairs?.keyDown(event)) return;
			if (vim?.keyDown(event)) return;
			if (view && saved.anchor === saved.focus && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
				const target = previewArrowTarget(view, current, saved.focus, event.key);
				if (target !== null) {
					event.preventDefault();
					saved = { anchor: target, focus: target };
					reveal();
					place();
					return;
				}
			}
			if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
				event.preventDefault();
				travel(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo");
			} else if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) {
				const range = adjacentPathRange(current, saved, event.key === "Backspace" ? "backward" : "forward");
				if (range) {
					event.preventDefault();
					change(replacePathSelection(current, range, ""));
				}
			}
		}
		function paste(event: ClipboardEvent) {
			if (event.defaultPrevented) return;
			event.preventDefault();
			const text = event.clipboardData?.getData("text/plain") ?? "";
			// Image/file/HTML-only clipboard contents are not text replacement.
			if (text === "") return;
			if (composing.current) pendingPaste.push(text);
			else if (!vim?.multiPaste(text)) replace(text);
		}
		function copy(event: ClipboardEvent) {
			if (event.defaultPrevented) return;
			remember();
			if (saved.anchor === saved.focus || !event.clipboardData) return;
			const { start, end } = atomicPathRange(current, saved);
			event.clipboardData.setData("text/plain", current.slice(start, end));
			event.preventDefault();
			if (event.type === "cut" && !composing.current) change(replacePathSelection(current, saved, ""));
		}
		/** Take in a caret or selection that has finished moving. */
		function arrive() {
			if (view && saved.anchor === saved.focus && document.activeElement === root) {
				const caret = settleLiveCaret(view, saved.focus);
				if (caret !== saved.focus) {
					saved = { anchor: caret, focus: caret };
					reveal();
					place();
					return;
				}
			}
			// This also runs on keys that move nothing, which must leave a box the
			// learner scrolled alone. Symbols only move the text after the browser's scroll.
			// A selection's end is followed only from in view: select-all leaves it far below.
			const active = document.activeElement === root, collapsed = saved.anchor === saved.focus;
			const endInView = active && !collapsed && !!view && selectionEndInView(root);
			if (reveal() && active) {
				if (collapsed) keepCaretInView(root, saved.focus);
				else if (endInView) keepSelectionEndInView(root);
			}
			if (view && saved.anchor === saved.focus && document.activeElement === root && atPreviewEnd(view, saved.focus)) {
				const selection = document.getSelection(), point = pathInputPoint(root, saved.focus);
				if (selection?.focusNode !== point.node || selection.focusOffset !== point.offset) restorePathSelection(root, saved);
			}
		}
		function selectionChanged() {
			remember();
			if (pressed || clickHold !== null || composing.current) return;
			arrive();
			vim?.settled();
			snippets?.selected();
			pairs?.selected();
		}
		/** Stop waiting for a second click and show what the caret now touches. */
		function releaseHold() {
			if (clickHold !== null) clearTimeout(clickHold);
			clickHold = null;
			if (composing.current) return;
			remember();
			arrive();
			vim?.settled();
			snippets?.selected();
			pairs?.selected();
		}
		function pointerDown(event: MouseEvent) {
			const widget = (event.target as Element).closest?.(`[${LIVE_WIDGET_ATTRIBUTE}]`);
			if (widget && view && !event.button) {
				// Clicking an equation opens it for editing, inside its closing delimiter.
				const math = view.format.items[Number(widget.getAttribute(LIVE_WIDGET_ATTRIBUTE))];
				event.preventDefault();
				root.focus();
				if (math?.kind === "math") {
					saved = { anchor: math.caret, focus: math.caret };
					reveal();
					place();
				}
				return;
			}
			if (clickHold !== null) clearTimeout(clickHold);
			clickHold = null;
			pressed = true;
		}
		function pointerUp(event: MouseEvent) {
			if (!pressed) return;
			pressed = false;
			remember();
			// Showing symbols moves the text, so a second click must land first:
			// it would otherwise select a symbol instead of the word under it.
			if (view && event.detail === 1 && saved.anchor === saved.focus) clickHold = setTimeout(releaseHold, DOUBLE_CLICK_MS);
			else releaseHold();
		}
		function startComposition() {
			remember();
			composing.current = true;
			compositionStart = snapshot();
			discardComposition = !!vim?.blocksTyping();
		}
		function endComposition() {
			// Some browsers send the final input immediately AFTER compositionend.
			queueMicrotask(() => {
				if (!mounted) return;
				let nextValue = readPathInput(root);
				let selection = readPathSelection(root) ?? saved;
				const previous = compositionStart ?? snapshot();
				if (discardComposition) {
					nextValue = previous.value;
					selection = previous.selection;
					discardComposition = false;
				}
				const reset = pendingExternal !== null && !pendingExternal.startsWith(previous.value);
				const nativeChanged = normalizePathInputValue(nextValue, callbacks.current.singleLine) !== current;
				const notify = pendingExternal === null || (!reset && nativeChanged);
				if (pendingExternal !== null) {
					if (pendingExternal.startsWith(previous.value)) {
						nextValue += pendingExternal.slice(previous.value.length);
					} else {
						nextValue = pendingExternal;
						selection = clampPathSelection(nextValue, selection);
					}
				}
				pendingExternal = null;
				compositionStart = null;
				beforeEdit = null;
				composing.current = false;
				if (reset) {
					history.reset();
					snippets?.clear();
					pairs?.clear();
				}
				change({ value: nextValue, selection }, !reset, previous, notify);
				if (pendingPaste.length) { const text = pendingPaste.join(""); pendingPaste = []; replace(text); }
				if (pendingPaths.length) { const paths = pendingPaths; pendingPaths = []; stage(paths); }
			});
		}
		controllerRef.current = {
			remember,
			repaint() { if (!composing.current) paint(saved, document.activeElement === root); },
			external(next) {
				next = normalizePathInputValue(next, callbacks.current.singleLine);
				if (composing.current) { pendingExternal = next; return; }
				if (next === current) return;
				remember();
				const previous = snapshot();
				// Dictation appends are undoable; a controlled reset starts fresh history.
				const reset = !next || !next.startsWith(current);
				if (reset) history.reset();
				else history.push(previous);
				const selection = saved.anchor === current.length && saved.focus === current.length
					? { anchor: next.length, focus: next.length } : clampPathSelection(next, saved);
				const kept = snippets?.external(current, next, saved);
				current = next;
				paint(kept ?? selection, document.activeElement === root);
				pairs?.external(previous.value);
				vim?.external(reset);
				// Dictation runs with focus on its button: still follow the words.
				keepCaretInView(root, saved.focus);
				measureAfterChips = true;
			},
			chipsDrawn() {
				if (measureAfterChips) keepCaretInView(root, saved.focus);
				measureAfterChips = false;
			},
			setVim(on) {
				if (on === !!vim) return;
				if (vim) { vim.destroy(); vim = null; return; }
				remember();
				vim = attachVim({
					root,
					history,
					snapshot,
					commit: (next, record, edits) => change(next, record, snapshot(), true, edits),
					select,
					reveal() { if (reveal()) keepCaretInView(root, saved.focus); },
					travelled: (direction, value) => snippets?.travelled(direction, value),
					leftInsert: (offset) => snippets?.leftInsert(offset),
					arrowTarget: (offset, key) => (view ? previewArrowTarget(view, current, offset, key) : null),
					bridges: () => !!snippets,
					matrixRow: (value, offset) => snippets?.matrixRow(value, offset) ?? null,
				});
				vim.settled();
			},
			setSnippets(on) {
				if (on === !!snippets) return;
				if (snippets) { snippets.destroy(); snippets = null; return; }
				snippets = attachSnippets({ root, history, snapshot, commit: (next, record) => change(next, record), select, vim: () => vim, set: () => callbacks.current.snippetSet ?? defaultSnippets() });
			},
			setPairs(on) {
				if (on === !!pairs) return;
				pairs = on ? attachPairs({ snapshot, commit: (next, record) => change(next, record), select, vim: () => vim, kinds: () => callbacks.current.pairKinds ?? EVERY_PAIR }) : null;
			},
		};
		paint(saved, false);
		dropped = false;
		if (initial.current.autoFocus) { root.focus(); reveal(); place(); measureAfterChips = true; }
		root.addEventListener(INSERT_FILE_PATHS_EVENT, insertEvent);
		root.addEventListener("beforeinput", beforeInput);
		root.addEventListener("input", input);
		root.addEventListener("keydown", keyDown);
		root.addEventListener("paste", paste);
		root.addEventListener("copy", copy);
		root.addEventListener("cut", copy);
		root.addEventListener("compositionstart", startComposition);
		root.addEventListener("compositionend", endComposition);
		document.addEventListener("selectionchange", selectionChanged);
		root.addEventListener("mousedown", pointerDown);
		root.addEventListener("focus", focused);
		root.addEventListener("blur", reveal);
		document.addEventListener("mouseup", pointerUp);
		return () => {
			mounted = false;
			composing.current = false;
			controllerRef.current = null;
			snippets?.destroy();
			vim?.destroy();
			if (clickHold !== null) clearTimeout(clickHold);
			root.removeEventListener(INSERT_FILE_PATHS_EVENT, insertEvent);
			root.removeEventListener("beforeinput", beforeInput);
			root.removeEventListener("input", input);
			root.removeEventListener("keydown", keyDown);
			root.removeEventListener("paste", paste);
			root.removeEventListener("copy", copy);
			root.removeEventListener("cut", copy);
			root.removeEventListener("compositionstart", startComposition);
			root.removeEventListener("compositionend", endComposition);
			document.removeEventListener("selectionchange", selectionChanged);
			root.removeEventListener("mousedown", pointerDown);
			root.removeEventListener("focus", focused);
			root.removeEventListener("blur", reveal);
			document.removeEventListener("mouseup", pointerUp);
		};
	}, []);

	React.useLayoutEffect(() => { controllerRef.current?.chipsDrawn(); }, [chips]);
	React.useLayoutEffect(() => { controllerRef.current?.external(value); }, [value, singleLine]);
	const wantsVim = vimKeys && !singleLine;
	React.useLayoutEffect(() => { controllerRef.current?.setVim(wantsVim); }, [wantsVim]);
	const wantsSnippets = snippetKeys && !singleLine;
	React.useLayoutEffect(() => { controllerRef.current?.setSnippets(wantsSnippets); }, [wantsSnippets]);
	const wantsPairs = !!(pairKinds?.brackets || pairKinds?.markdown) && !singleLine;
	React.useLayoutEffect(() => { controllerRef.current?.setPairs(wantsPairs); }, [wantsPairs]);
	const liveKey = liveFormat && !singleLine ? (liveFormat.math ? "math" : "markdown") : "off";
	const painted = React.useRef(liveKey);
	React.useLayoutEffect(() => {
		if (painted.current === liveKey) return;
		painted.current = liveKey;
		controllerRef.current?.repaint();
	}, [liveKey]);

	return <>
		<div
			{...props}
			ref={rootRef}
			role="textbox"
			aria-label={props["aria-label"] ?? placeholder}
			aria-multiline={singleLine ? "false" : "true"}
			aria-placeholder={placeholder}
			contentEditable
			suppressContentEditableWarning
			data-file-path-input=""
			data-empty={initial.current.value.length === 0 ? "true" : "false"}
			data-file-path-default={defaultDropTarget ? "" : undefined}
			data-placeholder={placeholder}
			className={cn("block w-full min-w-0 outline-none data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(data-placeholder)]", singleLine ? "whitespace-pre break-normal overflow-x-auto overflow-y-hidden" : "scroll-py-2 whitespace-pre-wrap break-words overflow-y-auto", className)}
			onKeyDown={(event) => {
				if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
				onKeyDown?.(event);
			}}
			onFocus={(event) => { controllerRef.current?.remember(); onFocus?.(event); }}
			onBlur={(event) => { controllerRef.current?.remember(); onBlur?.(event); }}
			onInput={onInput}
			onPaste={onPaste}
			onCopy={onCopy}
			onCut={onCut}
			onCompositionStart={onCompositionStart}
			onCompositionEnd={onCompositionEnd}
		>{initial.current.value}</div>
		{chips.map(({ host, path }) => createPortal(<FilePathChip path={path} contentEditable={false} />, host))}
	</>;
});
