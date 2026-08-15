---
publish: true
share_id: q8vw3n6r7k2m9x4p
title: Everything
publish_index: true
publish_download: true
secret_client: Acme
---

# Everything

Kitchen sink. Full snapshot (§11.1).

## Text

**Bold**, *italic*, ~~struck~~, ==highlighted==, `inline code`, and a
[normal link](https://example.com).

A footnote reference[^1].

[^1]: And the footnote itself.

## Callouts

> [!note] A titled callout
> With a body line.

> [!warning]
> An untitled one, which takes its type as the title.

## Lists

- One
- Two
  - Nested
- [ ] A task
- [x] A finished task

1. First
2. Second

## Table

| Column | Meaning |
|---|---|
| `stagedHash` | what the plugin verifies |
| `contentHash` | what the build compares |

## Code

```ts
export function shareId(): string {
  // 16 characters of Crockford base32 — ~80 bits.
  return generate();
}
```

## Math

$\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}$

## Links

Published: [[private-frontmatter]]. Unpublished: [[internal-roadmap]].
Heading link: [[published-b#Published B]].

## A block to reference

This paragraph carries a block id. ^kitchen-sink

## Comment

%%Not published.%%

## Quote

> An ordinary blockquote, which must not become a callout.
