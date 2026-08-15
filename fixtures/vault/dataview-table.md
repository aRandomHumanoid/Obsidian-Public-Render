---
publish: true
share_id: vw3n6r7k2m9x4qp8
title: Dataview table
---

# Dataview table

A published Dataview table is a point-in-time snapshot. It updates when the
note is re-published, and Stale status is how you know it needs to be (§9).

```dataview
TABLE status FROM #project
```

Inline too: `= this.title`.
