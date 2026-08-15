/**
 * mdast-level transforms: comment stripping and callouts (§5.4).
 */

import type { Blockquote, Paragraph, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import type { VFile } from 'vfile';

/**
 * Strip `%%comments%%` — defence in depth; the plugin already did this (§3.2).
 *
 * **Operates on the parsed AST, never on raw text.** A regex mis-pairs
 * delimiters when a fenced code block contains a stray `%%`, silently
 * swallowing everything between two unrelated markers (§11.2). Working on the
 * tree means `code` and `inlineCode` are separate node types that the walk
 * simply never enters, so the property falls out of the structure rather than
 * being maintained by hand.
 *
 * An unterminated `%%` drops everything after it. That is the fail-closed
 * direction — publishing half a comment is worse than publishing too little —
 * and it is reported so it does not pass unnoticed.
 */
export function remarkStripComments() {
  return (tree: Root, file: VFile) => {
    const state = { inComment: false, stripped: 0 };
    walk(tree, state);
    file.data['strippedComments'] = state.stripped;
    if (state.inComment) {
      file.data['unterminatedComment'] = true;
    }
  };
}

interface StripState {
  inComment: boolean;
  stripped: number;
}

function walk(parent: Parent, state: StripState): void {
  const kept: RootContent[] = [];

  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text' || child.type === 'html') {
      const value = stripValue(child.value, state);
      if (value !== child.value) state.stripped++;
      if (value.length > 0) {
        kept.push({ ...child, value } as RootContent);
      }
      continue;
    }

    if ('children' in child && Array.isArray((child as Parent).children)) {
      const before = state.inComment;
      walk(child as Parent, state);
      const emptied = (child as Parent).children.length === 0;
      // A container emptied by comment stripping goes with it; one that was
      // already empty (a `---` rule has no children) stays.
      if (emptied && (before || state.inComment || hadChildren(child))) continue;
      kept.push(child);
      continue;
    }

    // Leaf nodes — inlineCode, code, image, break, thematicBreak. Inside a
    // comment they are part of the comment.
    if (state.inComment) {
      state.stripped++;
      continue;
    }
    kept.push(child);
  }

  parent.children = kept as Parent['children'];
}

const CONTAINER_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'list',
  'listItem',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'tableCell',
  'tableRow',
  'table',
  'footnoteDefinition',
]);

function hadChildren(node: RootContent): boolean {
  return CONTAINER_TYPES.has(node.type);
}

function stripValue(value: string, state: StripState): string {
  if (!state.inComment && !value.includes('%%')) return value;

  let out = '';
  let i = 0;
  while (i <= value.length) {
    const idx = value.indexOf('%%', i);
    if (idx === -1) {
      if (!state.inComment) out += value.slice(i);
      break;
    }
    if (!state.inComment) {
      out += value.slice(i, idx);
      state.inComment = true;
    } else {
      state.inComment = false;
    }
    i = idx + 2;
  }
  return out;
}

/**
 * Obsidian callouts (§8): `> [!note] Title` becomes
 * `<div class="callout" data-callout="note">`, styled in the shell.
 *
 * Done on mdast rather than hast because blockquote structure is far easier to
 * reason about before it has been flattened into elements.
 */
const CALLOUT_HEAD = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;

export function remarkCallouts() {
  return (tree: Root) => {
    visitBlockquotes(tree, (node) => {
      const first = node.children[0];
      if (!first || first.type !== 'paragraph') return;
      const firstChild = first.children[0];
      if (!firstChild || firstChild.type !== 'text') return;

      const [line, ...restLines] = firstChild.value.split('\n');
      const match = CALLOUT_HEAD.exec(line ?? '');
      if (!match) return;

      const kind = (match[1] ?? 'note').toLowerCase();
      const inlineTitle = (match[3] ?? '').trim();

      // Split the opening paragraph at its first hard/soft break: everything
      // before is the title, everything after is the callout body.
      const rest: PhrasingContent[] = [];
      if (restLines.length > 0) rest.push({ type: 'text', value: restLines.join('\n') });
      rest.push(...first.children.slice(1));

      const breakAt = rest.findIndex((c) => c.type === 'break');
      const titleTail = breakAt === -1 ? [] : rest.slice(0, breakAt);
      const bodyHead = breakAt === -1 ? rest : rest.slice(breakAt + 1);

      const titleChildren: PhrasingContent[] = [];
      if (inlineTitle) titleChildren.push({ type: 'text', value: inlineTitle });
      titleChildren.push(...titleTail);
      if (titleChildren.length === 0) {
        titleChildren.push({ type: 'text', value: kind.charAt(0).toUpperCase() + kind.slice(1) });
      }

      const titleNode: Paragraph = {
        type: 'paragraph',
        children: titleChildren,
        data: { hName: 'div', hProperties: { className: ['callout-title'] } },
      };

      const replacement: Paragraph[] = [titleNode];
      const bodyText = bodyHead.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
      if (bodyText.length > 0) {
        replacement.push({ type: 'paragraph', children: bodyText });
      }

      node.children = [...replacement, ...node.children.slice(1)];
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: { className: ['callout'], 'data-callout': kind },
      };
    });
  };
}

function visitBlockquotes(node: Parent, fn: (node: Blockquote) => void): void {
  for (const child of node.children as RootContent[]) {
    if (child.type === 'blockquote') fn(child);
    if ('children' in child && Array.isArray((child as Parent).children)) {
      visitBlockquotes(child as Parent, fn);
    }
  }
}
