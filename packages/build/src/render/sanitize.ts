/**
 * The sanitization schema (§5.4).
 *
 * This is the last thing standing between rendered output and the reader, so
 * it is an allowlist and it is explicit. Three groups need adding on top of
 * `hast-util-sanitize`'s defaults:
 *
 *   - the presentation this pipeline generates itself (callouts, `<mark>`,
 *     shiki's spans);
 *   - MathML, because KaTeX runs in `mathml` mode — HTML mode would need a
 *     stylesheet and six font files, and the page is not permitted to make a
 *     single external request (§7.2, §7.3);
 *   - a bounded SVG subset for mermaid diagrams, which have already been
 *     through the SVG sanitizer in §5.5 but are not therefore exempt.
 */

import { defaultSchema } from 'hast-util-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';

const MATHML_TAGS = [
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
  'mspace',
  'mpadded',
  'mphantom',
  'menclose',
  'mfrac',
  'msqrt',
  'mroot',
  'mstyle',
  'merror',
  'msub',
  'msup',
  'msubsup',
  'munder',
  'mover',
  'munderover',
  'mmultiscripts',
  'mprescripts',
  'none',
  'mtable',
  'mtr',
  'mtd',
  'mlabeledtr',
];

// Deliberately absent: `annotation-xml`, which may contain HTML and is a
// long-standing mXSS vector. KaTeX's mathml output does not emit it.
const MATHML_ATTRS = [
  'display',
  'xmlns',
  'mathvariant',
  'mathsize',
  'mathcolor',
  'mathbackground',
  'stretchy',
  'fence',
  'separator',
  'lspace',
  'rspace',
  'accent',
  'accentunder',
  'largeop',
  'movablelimits',
  'symmetric',
  'minsize',
  'maxsize',
  'width',
  'height',
  'depth',
  'scriptlevel',
  'displaystyle',
  'columnalign',
  'rowalign',
  'columnlines',
  'rowlines',
  'frame',
  'framespacing',
  'linethickness',
  'notation',
  'encoding',
  'open',
  'close',
  'separators',
  'form',
  'voffset',
];

// Deliberately absent: `foreignObject` (an HTML escape hatch inside SVG),
// `image` and `use` with external references, and every animation element.
// mermaid is configured with `htmlLabels: false` precisely so it never needs
// foreignObject (see render/mermaid.ts).
const SVG_TAGS = [
  'svg',
  'g',
  'defs',
  'desc',
  'title',
  'style',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'marker',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'linearGradient',
  'radialGradient',
  'stop',
];

/**
 * Both the hast (camelCase) and raw (kebab-case) spellings are listed. hast
 * normalises attribute names through `property-information`, but which
 * spelling arrives depends on how the subtree was produced, and a redundant
 * entry costs nothing next to a diagram that silently loses its arrowheads.
 */
const SVG_ATTRS = [
  'className',
  'class',
  'id',
  'style',
  'viewBox',
  'xmlns',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fillOpacity',
  'fill-opacity',
  'fillRule',
  'fill-rule',
  'stroke',
  'strokeWidth',
  'stroke-width',
  'strokeDasharray',
  'stroke-dasharray',
  'strokeDashoffset',
  'stroke-dashoffset',
  'strokeLinecap',
  'stroke-linecap',
  'strokeLinejoin',
  'stroke-linejoin',
  'strokeOpacity',
  'stroke-opacity',
  'strokeMiterlimit',
  'stroke-miterlimit',
  'opacity',
  'markerEnd',
  'marker-end',
  'markerStart',
  'marker-start',
  'markerMid',
  'marker-mid',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'orient',
  'refX',
  'refY',
  'patternUnits',
  'gradientUnits',
  'gradientTransform',
  'offset',
  'stopColor',
  'stop-color',
  'stopOpacity',
  'stop-opacity',
  'textAnchor',
  'text-anchor',
  'dominantBaseline',
  'dominant-baseline',
  'alignmentBaseline',
  'alignment-baseline',
  'fontFamily',
  'font-family',
  'fontSize',
  'font-size',
  'fontWeight',
  'font-weight',
  'fontStyle',
  'font-style',
  'dx',
  'dy',
  'preserveAspectRatio',
  'clipPath',
  'clip-path',
  'mask',
  'role',
  'ariaLabel',
  'aria-label',
  'ariaRoledescription',
  'xmlSpace',
  'xml:space',
];

export function buildSanitizeSchema(): SanitizeSchema {
  const base = defaultSchema;

  return {
    ...base,
    /**
     * DOM-clobbering protection is switched off deliberately.
     *
     * `hast-util-sanitize` prefixes every `id` with `user-content-` so that a
     * document cannot shadow a global that page script relies on. These pages
     * ship **zero JavaScript** and their CSP has no `script-src` at all, so
     * there is no script to clobber. Keeping the prefix, meanwhile, actively
     * breaks output: mermaid references its own arrowhead markers as
     * `marker-end="url(#arrowhead12)"`, and renaming the target `id` without
     * rewriting the reference loses the arrowheads.
     *
     * This is safe *because* of §2.3 and §7.3, and would stop being safe the
     * moment a page shipped script. It is listed here so that change cannot be
     * made without reading this.
     */
    clobberPrefix: '',
    tagNames: [
      ...(base.tagNames ?? []),
      'mark',
      'section',
      'figure',
      'figcaption',
      'time',
      'abbr',
      'sub',
      'sup',
      'kbd',
      'samp',
      ...MATHML_TAGS,
      ...SVG_TAGS,
    ],
    attributes: {
      ...base.attributes,
      '*': [...(base.attributes?.['*'] ?? []), 'className', 'id', 'ariaHidden', 'aria-hidden', 'role'],
      div: ['className', 'dataCallout', 'data-callout', 'id'],
      span: ['className', 'style', 'id'],
      pre: ['className', 'style', 'tabIndex'],
      code: ['className', 'style'],
      mark: ['className'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'className'],
      a: [...(base.attributes?.['a'] ?? []), 'className', 'id', 'dataFootnoteRef', 'dataFootnoteBackref'],
      li: [...(base.attributes?.['li'] ?? []), 'id', 'className'],
      section: ['className', 'dataFootnotes', 'data-footnotes'],
      input: ['type', 'checked', 'disabled'],
      table: ['className'],
      th: [...(base.attributes?.['th'] ?? []), 'align'],
      td: [...(base.attributes?.['td'] ?? []), 'align'],
      time: ['dateTime', 'datetime'],
      ...Object.fromEntries(MATHML_TAGS.map((tag) => [tag, MATHML_ATTRS])),
      ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, SVG_ATTRS])),
    },
    protocols: {
      ...base.protocols,
      href: ['http', 'https', 'mailto'],
      src: ['http', 'https'],
    },
    // `style` elements survive only inside SVG, where mermaid needs them.
    //
    // Note what does *not* protect them: `sanitizeSvg` runs on attachments
    // only (assets.ts), so a `<style>` that mermaid inlines into the page has
    // never been through its `@import`/`url()` pass. What makes that safe is
    // the page CSP — `default-src 'none'` (§7.3) — which blocks the fetch an
    // `@import` or `url()` would attempt, and the pages ship zero JavaScript.
    // The protection is the header, not the sanitizer; anything that relaxes
    // the CSP has to revisit this line.
    allowComments: false,
  };
}
