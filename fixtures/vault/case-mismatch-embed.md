---
publish: true
share_id: x4qp8vw3n6r7k2m9
title: Case-mismatched embed
---

# Case-mismatched embed

Obsidian resolves case-insensitively on some filesystems and not on others, so
an embed that works on the author's machine can 404 in CI. That must be a
validation error at stage time, not a silent hole in the page.

![[NoSuchNote-WithCaps]]
