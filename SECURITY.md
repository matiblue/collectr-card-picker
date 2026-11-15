# Security

## Reporting
Please open a GitHub issue for low-risk bugs. For anything sensitive, use GitHub's private vulnerability reporting on this repository.

## Design review (v1.1.0)

**Attack surface.** The extension's content script runs on `https://app.getcollectr.com/*`. It reads card details from the page DOM, which includes data controlled by the showcase owner. It renders that data in its own panel and copies it to the clipboard on a user click.

| Area | Risk considered | Mitigation |
|---|---|---|
| Permissions | Over-broad host or API access | Only `storage`; one host match; no `tabs`, `scripting`, `<all_urls>`, or `clipboardWrite` permission needed. |
| Remote code | Loading or evaluating external scripts | None. No `eval`, `Function`, `fetch`, or remote resources. Explicit CSP: `script-src 'self'; object-src 'self'`. |
| XSS in panel | Card names or other page text rendered as HTML | All interpolated strings are HTML-escaped (`& < > " '`); numeric fields are coerced to bounded integers. Tested with an `<img onerror>` card name. |
| Image URLs | `javascript:`/`data:`/`http:` URLs in panel `<img>` | Only `https:` image URLs are kept. |
| Page tampering | Collectr page scripts reading or driving the panel, or forging clicks | Panel lives in a **closed** shadow root. Handlers ignore events where `isTrusted` is false. |
| Storage poisoning | Malformed or oversized data in `chrome.storage` | Everything loaded is re-sanitized: types are checked, strings length-capped, the list is capped at 1000 items, and the price must match `$N.NN`. |
| Messaging | Other extensions or pages sending commands | `onMessage` accepts only messages from this extension's own ID, and only one message type. |
| Clipboard | Copying without user intent | Copy happens only on a trusted click on the panel button. The text is plain text, never HTML. |
| Needs-list import | Malicious or huge pasted text or CSV files | Parsed as plain text with a hand-written CSV/TSV parser (no `eval`, no HTML parsing). Files are capped at 5 MB and the list at 5000 rows. Fields are length-capped and HTML-escaped when shown. Tested with an `<img onerror>` card name. |
| Toolbar badge | Spoofed badge updates | The background worker accepts `cpp-badge` only from this extension's own content script (sender ID check), clamps the count to 0–999, and sets it only on the sender's tab. |
| Privacy | Data exfiltration | No network calls or analytics. Data stays in local extension storage. |

**Residual risk.** A showcase owner controls card text, so the copied message could contain misleading text, but only as plain text the user can read before sending. A Collectr DOM change could break parsing. That fails safe: cards aren't recognized and nothing is selected.
