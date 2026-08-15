---
publish: true
share_id: 3n6r7k2m9x4qp8vw
title: Math and mermaid
---

# Math and mermaid

Inline math: $e^{i\pi} + 1 = 0$.

Display math:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

A diagram:

```mermaid
graph TD
  A[Plugin] --> B[published/]
  B --> C[CI]
  C --> D[KV]
  C --> E[R2]
  D --> F[Worker]
  E --> F
```

Neither may produce a `<script>` tag, and the page must still work with
JavaScript entirely forbidden by CSP (§7.3).
