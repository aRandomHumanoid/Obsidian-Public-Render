/**
 * SVG sanitization (§5.5).
 *
 * SVG is an active document format and must be sanitized, not merely passed
 * through. This is not hypothetical: Excalidraw's auto-export is SVG, so it is
 * the normal path for diagrams. An SVG can carry `<script>`, event handlers,
 * `<foreignObject>` and external references, and it is served from the same
 * origin as the pages — so the strict CSP in §7.3 does not protect it, because
 * that governs the *page*, not an asset fetched directly.
 *
 * Rasterizing instead would remove the class of problem entirely, at the cost
 * of scalability and text selection in diagrams. Sanitize-plus-headers is the
 * chosen trade; the residual risk is a sanitizer bypass reaching same-origin
 * script execution, which is why assets also get `sandbox` headers of their
 * own (§7.3) — defence in depth, because the sanitizer is the kind of thing
 * that acquires a bypass.
 */

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

let purifier: ReturnType<typeof createDOMPurify> | null = null;

/**
 * JSDOM's window is structurally a DOM window but not nominally the `Window`
 * TypeScript's DOM lib describes, so it needs a cast either way.
 *
 * The cast targets DOMPurify's *own* parameter type rather than
 * `Window & typeof globalThis`. That matters because `WindowLike` requires
 * `trustedTypes`, which only exists once `@types/trusted-types` is installed —
 * and `dompurify` declares it as an **optional** dependency. CI installs with
 * `--omit=optional` (§13: a vault with no diagrams should not pay for a
 * Chromium download), so naming the DOM type there typechecks on a developer
 * machine and fails on the runner. Deferring to `Parameters<…>` means whatever
 * DOMPurify asks for is what it gets, present or absent.
 */
function getPurifier(): ReturnType<typeof createDOMPurify> {
  if (purifier) return purifier;
  const window = new JSDOM('').window;
  purifier = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  return purifier;
}

/** Elements we drop outright regardless of what DOMPurify would allow. */
const FORBID_TAGS = Object.freeze([
  'script',
  'foreignObject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'handler',
  'listener',
  'set',
  'animate',
  'animateTransform',
  'animateMotion',
]);

/**
 * The same list, lowercased, for the reporting hook.
 *
 * `uponSanitizeElement` receives `tagName` already lowercased, so comparing it
 * against the camelCase entries above matches nothing. That went unnoticed
 * because DOMPurify's `addToSet` lowercases the caller's array *in place* while
 * parsing config — before any hook runs — so the list silently repaired itself.
 * `Object.freeze` above stops that mutation (which is the point: a config array
 * is ours, not DOMPurify's), so the comparison set is derived explicitly here
 * rather than depending on undocumented behaviour that only ever affected what
 * we *report*, never what we remove.
 */
const FORBID_TAGS_LOWER = new Set(FORBID_TAGS.map((tag) => tag.toLowerCase()));

/**
 * Attributes we drop on top of DOMPurify's own rules. `href`/`xlink:href` are
 * handled separately below because a *local fragment* reference is legitimate
 * and common — mermaid's arrowhead markers use them.
 */
const FORBID_ATTR = Object.freeze([
  'xlink:show',
  'xlink:actuate',
  'externalResourcesRequired',
  'requiredExtensions',
]);

export interface SvgSanitizeResult {
  svg: string;
  /** What was removed, so the build can report it rather than silently fixing. */
  removed: string[];
}

export function sanitizeSvg(input: string): SvgSanitizeResult {
  const purify = getPurifier();
  const removed: string[] = [];

  const onRemoved = (data: { tagName?: string; attrName?: string }) => {
    if (data.tagName) removed.push(`<${data.tagName}>`);
    else if (data.attrName) removed.push(`@${data.attrName}`);
  };
  purify.addHook('uponSanitizeElement', (_node, data) => {
    if (data.tagName && FORBID_TAGS_LOWER.has(data.tagName.toLowerCase())) {
      onRemoved({ tagName: data.tagName });
    }
  });
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName;
    // Every `on*` handler, unconditionally.
    if (name.startsWith('on')) {
      data.keepAttr = false;
      onRemoved({ attrName: name });
      return;
    }
    // Any href that is not a local fragment. External references in an SVG are
    // a data-exfiltration channel and a same-origin script vector.
    if (name === 'href' || name === 'xlink:href') {
      const value = (data.attrValue ?? '').trim();
      if (!value.startsWith('#')) {
        data.keepAttr = false;
        onRemoved({ attrName: `${name}="${value.slice(0, 40)}"` });
      }
    }
    // `style` may not pull in anything external.
    if (name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(data.attrValue ?? '')) {
      data.keepAttr = false;
      onRemoved({ attrName: 'style (external reference)' });
    }
  });

  let svg: string;
  try {
    svg = purify.sanitize(input, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // A fresh copy each call: DOMPurify lowercases the array it is handed,
      // in place. Handing it ours would work, but relying on that is how the
      // hook above came to look correct without being correct.
      FORBID_TAGS: [...FORBID_TAGS],
      FORBID_ATTR: [...FORBID_ATTR],
      ADD_TAGS: ['style'],
      WHOLE_DOCUMENT: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
    }) as unknown as string;
  } finally {
    purify.removeAllHooks();
  }

  // `<style>` survives because mermaid depends on it, but its *content* is not
  // covered by attribute hooks, so it gets its own pass.
  svg = svg.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_all, attrs: string, css: string) => {
    const cleaned = css
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\s*\([^)]*\)/gi, 'none')
      .replace(/expression\s*\([^)]*\)/gi, '');
    if (cleaned !== css) removed.push('<style> external reference');
    return `<style${attrs}>${cleaned}</style>`;
  });

  return { svg, removed: [...new Set(removed)] };
}

/** True when the bytes look like SVG rather than a raster image. */
export function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf8', { fatal: false }).decode(bytes.slice(0, 1024)).trimStart();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!DOCTYPE svg');
}
