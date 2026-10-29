import { useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

const MAX_MATCHES = 1000;
// CSS Custom Highlight API: Safari 17.2+, Chromium 105+. Without it, matches are counted and scrolled to.
const highlights = (
  globalThis as {
    CSS?: { highlights?: Map<string, unknown> };
  }
).CSS?.highlights;
const HighlightCtor = (
  globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
).Highlight;

function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += node.nodeValue ?? "";
  }
  const lower = text.toLowerCase();
  const ranges: Range[] = [];
  let node = 0;
  const locate = (offset: number) => {
    while (node < nodes.length - 1 && starts[node + 1] <= offset) node++;
    return [nodes[node], offset - starts[node]] as const;
  };
  for (
    let at = lower.indexOf(needle);
    at >= 0 && ranges.length < MAX_MATCHES;
    at = lower.indexOf(needle, at + needle.length)
  ) {
    const range = document.createRange();
    range.setStart(...locate(at));
    range.setEnd(...locate(at + needle.length));
    ranges.push(range);
  }
  return ranges;
}

/** Finds `query` in the text under `root` and highlights every match plus the current one. */
export function useTextFind(
  root: RefObject<HTMLElement | null>,
  query: string,
  content: unknown,
) {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  useLayoutEffect(() => {
    setRanges(root.current && query ? findRanges(root.current, query) : []);
    setIndex(0);
  }, [root, query, content]);
  useEffect(() => {
    const current = ranges[index];
    if (highlights && HighlightCtor) {
      highlights.set("find", new HighlightCtor(...ranges));
      highlights.set(
        "find-current",
        current ? new HighlightCtor(current) : new HighlightCtor(),
      );
    }
    current?.startContainer.parentElement?.scrollIntoView?.({
      block: "center",
    });
    return () => {
      highlights?.delete("find");
      highlights?.delete("find-current");
    };
  }, [ranges, index]);
  const step = (delta: number) =>
    setIndex((value) =>
      ranges.length ? (value + delta + ranges.length) % ranges.length : 0,
    );
  return {
    count: ranges.length,
    capped: ranges.length >= MAX_MATCHES,
    index,
    next: () => step(1),
    previous: () => step(-1),
  };
}
