## Browser Compatibility

The Local-First Architecture relies on standard web primitives.

| Feature | Chrome | Firefox | Safari | Edge | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `iframe srcdoc` | Yes | Yes | Yes | Yes | Supported since 2013 |
| CSP `<meta>` | Yes | Yes | Yes | Yes | Full support |
| Opaque Origin | Yes | Yes | Yes | Yes | Standard behavior for sandboxed iframes |
| Service Worker | Yes | Yes | Yes | Yes | For VFS domain |

**Known Quirks**:
- **Safari**: `srcdoc` iframes might sometimes inherit the parent's origin in very old versions, but modern Safari respects the `sandbox` attribute correctly (forcing opaque origin).
- **Firefox**: `data:` URIs in `srcdoc` might behave differently regarding CSP inheritance, but our architecture uses `srcdoc` string directly, not `data:` URI.
