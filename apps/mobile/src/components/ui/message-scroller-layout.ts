/** Mounted row geometry in content coordinates, independent of native scroll events. */
export type MessageLayout = { y: number; height: number; scrollAnchor: boolean };

/** Space below a short newly appended turn so its anchor can align above the composer. */
export function messageAnchorSpacer(
  anchorY: number,
  contentWithoutSpacer: number,
  viewport: number,
  margin: number,
) {
  return Math.max(0, viewport - (contentWithoutSpacer - anchorY) - margin);
}

/** Computes bounded scroll offsets for the current shadcn imperative alignment options. */
export function messageScrollOffset(
  row: MessageLayout,
  options: {
    align: "start" | "center" | "end" | "nearest";
    scrollMargin: number;
    viewport: number;
    content: number;
    offset: number;
  },
) {
  const { align, scrollMargin, viewport, content, offset } = options;
  let target = row.y - scrollMargin;
  if (align === "center") target = row.y - (viewport - row.height) / 2;
  if (align === "end") target = row.y + row.height - viewport + scrollMargin;
  if (align === "nearest") {
    if (row.y >= offset + scrollMargin && row.y + row.height <= offset + viewport - scrollMargin)
      return offset;
    target =
      row.y < offset + scrollMargin
        ? row.y - scrollMargin
        : row.y + row.height - viewport + scrollMargin;
  }
  return Math.max(0, Math.min(target, Math.max(0, content - viewport)));
}
