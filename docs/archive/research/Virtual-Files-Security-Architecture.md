# Virtual Files Security Architecture

> **Superseded by [ADR-004](../../ADR-004-files-as-blob-urls.md)** (2026-10-13). Files now reach the
> guest as `blob:` URLs created in its own realm; the Service-Worker hub described here never served
> a file to the opaque-origin guest and was removed. Kept as a record of the earlier design.

Moved: this document was a byte-identical copy of
[`VIRTUAL_FILES_SECURITY_ANALYSIS.md`](VIRTUAL_FILES_SECURITY_ANALYSIS.md), which is the one kept
(backlog H1).
