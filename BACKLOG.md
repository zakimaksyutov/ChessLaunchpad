# Backlog

Items here are tracked but not currently scheduled. Move to the appropriate spec or open an issue when picked up.

## Cleanup

### Remove `cleanupLegacyIndexedDB` boot sweep

After the games-page rewrite (see `docs/product-specs/GAMES.md`), the old `/games` page's three IndexedDB databases (`chesslaunchpad-games-db`, `chesslaunchpad-masters-explorer`, `chesslaunchpad-opponent-analysis`) are no longer used. `app/src/utils/cleanupLegacyIDB.ts` is called once on boot to delete them, gated by a `localStorage` flag (`chesslaunchpad:legacyIDBCleanup:v1`).

Once a reasonable adoption window has passed and existing users have launched the new version at least once, delete:

- `app/src/utils/cleanupLegacyIDB.ts`
- The import + call in `app/src/index.tsx`

The localStorage flag itself can be left to expire naturally — it's a tiny key and removing it isn't worth a second cleanup pass.
