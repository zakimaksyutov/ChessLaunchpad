# Games Page — Backlog

Items moved out of `GAMES.md` that are not yet implemented.

---

## Opponent Theory Detection

For each game where the user had a theory gap (deviation or eval drop), determine whether the opponent was **more prepared**:

1. Download the opponent's last **1,000** games from the Lichess API (same NDJSON endpoint, cached in IndexedDB).
2. Replay each opponent game to check how many times the opponent reached the gap position.
3. If the opponent has played this position **≥ 5 times**, tag the game row with an **"Opponent knew this"** badge.

This helps the user understand whether their theory gap was exploited by a prepared opponent.

## Time-Pressure Signals

Surface time-pressure context in game rows (e.g., clock time remaining at deviation points). Not yet designed.
