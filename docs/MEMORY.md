# Memory — Conventions & Patterns

Knowledge captured during development. Keep entries short.

## IndexedDB

Used by `services/LichessCloudEvalService.ts` (cloud-eval cache) via the `idb` library.

- **Batch writes** — One `readwrite` transaction for multiple `put()` calls; `await tx.done`.
- **`count()` for counts** — Don't load all records just to count them.
- **Singleton connection** — Cache the `openDB()` promise at module level.
