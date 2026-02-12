# Research 08: Session Exhaustion (DoS)

## Summary

The new architecture introduces Server-Side Session State to manage Unique Origins and CSP configurations. The server stores session data in an in-memory `Map`.

## Vulnerability

There is no rate limiting or cleanup mechanism for these sessions. An attacker (or a buggy client) can generate an unlimited number of sessions by calling `POST /api/session`. This will eventually consume all available memory on the server, causing a Denial of Service.

## Mitigation

1.  **Rate Limiting**: Limit the number of sessions created per IP or time window.
2.  **TTL / Expiration**: Sessions should expire after a certain time of inactivity.
3.  **LRU Cache**: Use a bounded cache (LRU) instead of an unbounded Map, evicting old sessions when full.
