import type { Element, Root, RootContent } from 'hast';

const outputPath = /^\/(?:runner\/jobs\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\/)?output\/([^/]+)$/i;
const linkBlocks = new Set(['p', 'li', 'ul', 'ol']);
const linkWrappers = new Set(['strong', 'em', 'del']);

export function hideAttachedOutputLinks({ origin, files }: { origin: string; files: readonly { name: string }[] }) {
  const names = new Set(files.map(file => file.name));

  function isDuplicateLink(node: Element) {
    const href = node.properties.href;
    if (node.tagName !== 'a' || typeof href !== 'string') return false;
    try {
      const url = new URL(href, origin);
      if (url.origin !== origin && url.protocol !== 'sandbox:') return false;
      const match = outputPath.exec(url.pathname);
      return !!match && names.has(decodeURIComponent(match[1]));
    } catch {
      return false;
    }
  }

  // Ignore whitespace when deciding whether an entire paragraph or list is a download control.
  function downloadOnly(node: RootContent): boolean | undefined {
    if (node.type === 'text') return node.value.trim() ? false : undefined;
    if (node.type !== 'element') return false;
    if (isDuplicateLink(node)) return true;
    if (!linkBlocks.has(node.tagName) && !linkWrappers.has(node.tagName)) return false;
    let hasDownload = false;
    for (const child of node.children) {
      const result = downloadOnly(child);
      if (result === false) return false;
      if (result) hasDownload = true;
    }
    return hasDownload || undefined;
  }

  return function removeDuplicateLinks(parent: Root | Element) {
    for (let index = parent.children.length - 1; index >= 0; index--) {
      const child = parent.children[index];
      if (child.type !== 'element') continue;
      if (linkBlocks.has(child.tagName) && downloadOnly(child)) parent.children.splice(index, 1);
      else if (isDuplicateLink(child)) parent.children.splice(index, 1, ...child.children);
      else removeDuplicateLinks(child);
    }
  };
}
