# Changelog

## Unreleased

- Treat an interrupted tracked parent turn as a durable pause so Escape cannot trigger another automatic continuation.
- Add canonical, non-resumable `/goal stop` control while preserving `cancel` and `clear` aliases.
- Add persisted `/goal budget +N` and `/goal budget no-progress +N` controls with overflow checks, exact exhausted-dimension reporting, and explicit-resume recovery.
- Add argument completions and regression coverage for pause, stop, and budget controls.

## 0.2.2

- Serialize goal-owned model tool operations and fail closed on unobserved continuation delivery.
- Harden foreground delegation terminal validation, incremental structured-copy safety, child call limits, derived aggregate allowance, deadlines, expansion, review rendering, and saturating usage accounting.
- Add FIFO serialization, busy cancellation, namespace recovery, hostile review payload, event-listener cleanup, index-only array-copy safety, real AgentSession lifecycle, and immutable Git install smoke coverage (115 deterministic tests).
- Add production-only audit CI.
