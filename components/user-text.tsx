"use client";

import { memo, type ComponentProps } from "react";
import { Streamdown, type ExtraProps, type PluginConfig } from "streamdown";
import { markdownSurfaceClass, streamdownPlugins } from "@/components/ai-elements/message";
import { FilePathChip, PathText } from "@/components/file-path-chip";
import { MarkdownCode, mdComponents } from "@/components/md-blocks";
import { useAppearance } from "@/components/settings/appearance";
import { cn } from "@/lib/utils";
import { isFilePath, transformMathDelimiters } from "@/src/core";

type MdNode = { type: string; value?: string; children?: MdNode[] };

const FLOW_PARENTS = new Set(["root", "blockquote", "listItem"]);

/** People type `List<string>` and `a<b` without meaning HTML, and the HTML
 *  pipeline drops whatever looks like a tag, losing their words. Learner text
 *  keeps every HTML node as literal text instead. */
function remarkLiteralHtml() {
	return (tree: MdNode) => {
		const visit = (node: MdNode) => {
			node.children?.forEach((child, i) => {
				if (child.type !== "html") return visit(child);
				const text = { type: "text", value: child.value };
				node.children![i] = FLOW_PARENTS.has(node.type) ? { type: "paragraph", children: [text] } : text;
			});
		};
		visit(tree);
	};
}

// Module identity matters: Streamdown is memoized. The literal-HTML step runs
// first in the slot so remark-breaks still splits its newlines.
const cjk = streamdownPlugins.cjk as unknown as { remarkPluginsAfter: unknown[] };
const pluginsWithMath = {
	...streamdownPlugins,
	cjk: { ...cjk, remarkPluginsAfter: [remarkLiteralHtml, ...cjk.remarkPluginsAfter] },
} as unknown as PluginConfig;
const pluginsWithoutMath = { ...pluginsWithMath, math: undefined } as PluginConfig;

/** Attached files are stored as backticked rooted paths, so an inline code
 *  span holding one is an attachment, not code. Fences stay code. */
function UserMarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
	const { children } = props;
	if (!("data-block" in props) && typeof children === "string" && isFilePath(children)) {
		return <FilePathChip path={children} />;
	}
	return <MarkdownCode {...props} />;
}

const userComponents = { ...mdComponents, code: UserMarkdownCode };

export interface UserTextViewProps {
	text: string;
	markdown: boolean;
	math: boolean;
	/** Wrap the text in quote marks, whatever its block layout. */
	quoted?: boolean;
	className?: string;
}

/** Learner-authored text in the transcript. Display only: the stored text and
 *  what the model receives are never rewritten. */
export const UserTextView = memo(function UserTextView({ text, markdown, math, quoted, className }: UserTextViewProps) {
	if (!markdown) {
		return (
			<div className={cn("lh-prose whitespace-pre-wrap", className)}>
				{quoted && "“"}<PathText text={text} />{quoted && "”"}
			</div>
		);
	}
	return (
		<Streamdown
			// Streamdown memoizes each block by its text, not its plugins, so
			// without a remount any block the math step leaves unchanged would
			// keep its old render when the toggle changes (or settings load).
			key={math ? "math" : "no-math"}
			mode="static"
			className={cn(markdownSurfaceClass, quoted && "lh-quoted", className)}
			components={userComponents}
			plugins={math ? pluginsWithMath : pluginsWithoutMath}
		>
			{math ? transformMathDelimiters(text) : text}
		</Streamdown>
	);
});

/** UserTextView, following the two Appearance toggles. */
export function UserText(props: Omit<UserTextViewProps, "markdown" | "math">) {
	const { userMarkdown, userMath } = useAppearance().appearance.mdRendering;
	return <UserTextView {...props} markdown={userMarkdown} math={userMath} />;
}
