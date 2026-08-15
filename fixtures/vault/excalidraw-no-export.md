---
publish: true
share_id: p8vw3n6r7k2m9x4q
title: Excalidraw without an export
---

# Excalidraw without an export

Excalidraw embeds require the plugin's auto-exported SVG companion (§8). The
drawing itself is a JSON document that nothing downstream can render, so a
missing companion is a validation error rather than a blank space on the page.

![[sketch.excalidraw]]
