/** Scrolling to a caret set from script. linkedom has no layout, so the boxes
 *  are stubbed; the rendered result was measured in Chrome and Electron. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { keepCaretInView, keepPreviewInView, keepSelectionEndInView, selectionEndInView, renderLiveInput, renderPathInput, revealLiveInput } from "../components/path-input-dom.ts";
import { readLiveFormat } from "../src/core/index.ts";

function setup(value: string, boxes: Array<Partial<DOMRect>>, scrollPadding?: { top: string; bottom: string }) {
	const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const root = document.getElementById("root") as unknown as HTMLElement;
	renderPathInput(root, value);
	root.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 300 }) as DOMRect;
	Object.defineProperties(root, { clientHeight: { value: 100 }, clientWidth: { value: 300 }, clientTop: { value: 0 }, clientLeft: { value: 0 } });
	(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({ setStart() {}, setEnd() {}, collapse() {}, selectNode() {}, getClientRects: () => boxes });
	if (scrollPadding) padded(root, scrollPadding);
	root.scrollTop = 50; root.scrollLeft = 0;
	return root;
}
function padded(root: HTMLElement, { top, bottom }: { top: string; bottom: string }) {
	Object.assign(root.ownerDocument.defaultView!, { getComputedStyle: () => ({ scrollPaddingTop: top, scrollPaddingBottom: bottom }) });
}
const EIGHT = { top: "8px", bottom: "8px" };

describe("keepCaretInView", () => {
	it("scrolls down to a caret below the box, by the smallest amount", () => {
		const root = setup("ab", [{ top: 110, bottom: 132, left: 5, right: 5, height: 22 }]);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 82);
	});
	it("scrolls up to a caret above the box", () => {
		const root = setup("ab", [{ top: -30, bottom: -8, left: 5, right: 5, height: 22 }]);
		keepCaretInView(root, 0);
		assert.equal(root.scrollTop, 20);
	});
	it("leaves a visible caret alone", () => {
		const root = setup("ab", [{ top: 10, bottom: 32, left: 5, right: 5, height: 22 }]);
		keepCaretInView(root, 1);
		assert.equal(root.scrollTop, 50);
	});
	it("scrolls a single line sideways, but not by a caret taller than the box", () => {
		const root = setup("ab", [{ top: -1, bottom: 121, left: 500, right: 500, height: 122 }]);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 50);
		assert.equal(root.scrollLeft, 200);
	});
	it("does nothing without layout", () => {
		const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
		const root = document.getElementById("root") as unknown as HTMLElement;
		renderPathInput(root, "ab");
		root.scrollTop = 50;
		keepCaretInView(root, 1);
		assert.equal(root.scrollTop, 50);
	});

	it("stops short of the bottom edge by the box's scroll padding", () => {
		const root = setup("ab", [{ top: 110, bottom: 132, left: 5, right: 5, height: 22 }], EIGHT);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 90);
	});
	it("stops short of the top edge by the box's scroll padding", () => {
		const root = setup("ab", [{ top: -30, bottom: -8, left: 5, right: 5, height: 22 }], EIGHT);
		keepCaretInView(root, 0);
		assert.equal(root.scrollTop, 12);
	});
	it("treats a caret inside the scroll padding as out of view", () => {
		const root = setup("ab", [{ top: 74, bottom: 96, left: 5, right: 5, height: 22 }], EIGHT);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 54);
	});
	it("leaves a caret that clears the scroll padding alone", () => {
		const root = setup("ab", [{ top: 70, bottom: 92, left: 5, right: 5, height: 22 }], EIGHT);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 50);
	});
	it("reads an unset scroll padding as none", () => {
		const root = setup("ab", [{ top: 110, bottom: 132, left: 5, right: 5, height: 22 }], { top: "auto", bottom: "auto" });
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 82);
	});
	it("does not scroll up and down when the padding leaves no room for the caret", () => {
		const root = setup("ab", [{ top: 10, bottom: 95, left: 5, right: 5, height: 85 }], EIGHT);
		keepCaretInView(root, 2);
		assert.equal(root.scrollTop, 50);
	});
});

describe("a selection's moving end", () => {
	/** The browser's selection has its end in the box's text. */
	const ending = (root: HTMLElement) => {
		Object.assign(root.ownerDocument, { getSelection: () => ({ focusNode: root.firstChild, focusOffset: 1 }) });
		return root;
	};
	it("is in view while any of it shows", () => {
		assert.equal(selectionEndInView(ending(setup("ab", [{ top: 90, bottom: 112, left: 5, right: 5, height: 22 }]))), true);
		assert.equal(selectionEndInView(ending(setup("ab", [{ top: -10, bottom: 12, left: 5, right: 5, height: 22 }]))), true);
	});
	it("is out of view wholly above or below the box", () => {
		assert.equal(selectionEndInView(ending(setup("ab", [{ top: 100, bottom: 122, left: 5, right: 5, height: 22 }]))), false);
		assert.equal(selectionEndInView(ending(setup("ab", [{ top: -22, bottom: 0, left: 5, right: 5, height: 22 }]))), false);
	});
	it("is out of view when the selection is elsewhere on the page", () => {
		const root = setup("ab", [{ top: 10, bottom: 32, left: 5, right: 5, height: 22 }]);
		Object.assign(root.ownerDocument, { getSelection: () => ({ focusNode: root.ownerDocument.body, focusOffset: 0 }) });
		assert.equal(selectionEndInView(root), false);
		keepSelectionEndInView(root);
		assert.equal(root.scrollTop, 50);
	});
	it("scrolls to the spot the selection is at, by the smallest amount", () => {
		const root = ending(setup("ab", [{ top: 110, bottom: 132, left: 5, right: 5, height: 22 }], EIGHT));
		keepSelectionEndInView(root);
		assert.equal(root.scrollTop, 90);
	});
});

describe("keepPreviewInView", () => {
	const rect = (top: number, bottom: number) => () => ({ top, bottom }) as DOMRect;
	function equation(scrollPadding?: { top: string; bottom: string }) {
		const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
		const root = document.getElementById("root") as unknown as HTMLElement;
		const value = "$$x$$";
		const { view } = renderLiveInput(root, value, readLiveFormat(value, { math: true }));
		if (scrollPadding) padded(root, scrollPadding);
		root.getBoundingClientRect = rect(0, 100);
		view.previews.get("i0")!.getBoundingClientRect = rect(100, 140);
		root.querySelector(".lh-lf-source")!.getBoundingClientRect = rect(70, 90);
		revealLiveInput(view, { anchor: 0, focus: 0 });
		root.scrollTop = 0;
		return { root, view };
	}

	it("keeps the same gap under a preview as under a caret", () => {
		const { root, view } = equation(EIGHT);
		keepPreviewInView(root, view);
		assert.equal(root.scrollTop, 48);
	});
	it("stops with the source clear of the top edge, where the caret stops", () => {
		const { root, view } = equation(EIGHT);
		view.previews.get("i0")!.getBoundingClientRect = rect(30, 300);
		root.querySelector(".lh-lf-source")!.getBoundingClientRect = rect(10, 30);
		keepPreviewInView(root, view);
		assert.equal(root.scrollTop, 2);
	});
	it("leaves a caret above what a selection reveals in view", () => {
		const { root, view } = equation(EIGHT);
		(root.ownerDocument as unknown as { createRange: () => unknown }).createRange = () => ({ setStart() {}, setEnd() {}, collapse() {}, selectNode() {}, getClientRects: () => [{ top: 8, bottom: 30, left: 0, right: 0, height: 22 }] });
		keepPreviewInView(root, view, 0);
		assert.equal(root.scrollTop, 0);
	});
});

describe("revealLiveInput", () => {
	function draw(value: string) {
		const { document } = parseHTML("<html><body><div id='root'></div></body></html>");
		const root = document.getElementById("root") as unknown as HTMLElement;
		return renderLiveInput(root, value, readLiveFormat(value, { math: true })).view;
	}
	it("says when symbols appeared or vanished, which is when the text moved", () => {
		const view = draw("**b** rest");
		assert.equal(revealLiveInput(view, { anchor: 3, focus: 3 }), true, "symbols appear");
		assert.equal(revealLiveInput(view, { anchor: 3, focus: 3 }), false, "nothing changed");
		assert.equal(revealLiveInput(view, { anchor: 9, focus: 9 }), true, "symbols vanish");
		assert.equal(revealLiveInput(view, { anchor: 8, focus: 8 }), false, "the caret moved, nothing else did");
	});
});
