---
publish: true
share_id: 2m9x4qp8vw3n6r7k
title: Private frontmatter
publish_index: false
publish_download: true
client: Acme Corporation
invoice_total: 48000
personal_note: remember to chase this
tags:
  - private
  - billing
aliases:
  - The Acme thing
created: 2026-01-04
---

# Private frontmatter

Only allowlisted keys may survive into the staged file. Allowlist, not
denylist — a denylist leaks the first personal property you forget to add to
it (§4.1).

Nothing above the body should be reachable from the published artifact except
the title, the share id, the two hashes and the two booleans.
