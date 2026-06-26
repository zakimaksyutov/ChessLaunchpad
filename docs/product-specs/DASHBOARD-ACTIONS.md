# Dashboard Actions Tile — Product Specification

> Status: **implemented**. Supersedes the standalone "Start Training"
> call-to-action described in [`DASHBOARD.md`](./DASHBOARD.md) §1.5.

## Overview

A single "what to do next" surface on the dashboard. Instead of a lone
"Start Training" button that dead-ends for users with nothing to train,
the dashboard leads with a tile of **context-aware actions** derived
from the user's current state. It evolves over time and is the main
mechanism for guiding new users toward a useful first step.

## Placement

A full-width tile (same width as the Activity feed) at the **top of the
dashboard**, above the Today's Session / Lifetime / Repertoire grid. It
replaces the standalone "Start Training" button.

## Behavior

- Renders a short list of **action rows**, each with an icon, a label
  (with a count when relevant), and a click target. The whole row is
  clickable.
- **Start Training** is a first-class action and stays the most
  visually prominent / primary one when present (e.g. "Start Training
  (N due)").
- Actions are **not dismissible** for now — they appear and disappear
  purely from current state.
- **"Why this action?" explainers** — an action may carry an opt-in
  rationale, triggered by a small **💡** segment fused onto the right
  edge of the action button (a sibling control, so expanding it never
  navigates). It targets users who may not yet understand the action's
  value and disappears once they do:
    - **Link a chess account** — always, while shown.
    - **Analyze N new games** — only when it *leads* (nothing due) and
      there are no surfaced mistakes yet — i.e. a freshly-synced new
      account. Once a mistake exists, "Review opening mistakes" speaks for
      itself and the explainer is dropped.
- **Empty state** — when no actions apply, show a positive "You're all
  caught up" message instead of an empty tile.

## Initial Actions

More actions are added incrementally. The first set:

- **Start Training** — leads to training; surfaces the due count. →
  `/training`.
- **Review games** — a single `/games` action covering the two game
  states (both land on `/games`, which handles analyze-then-review):
  ingested-but-unanalyzed games (**"Analyze N new games"**) and
  analyzed games with an unreviewed opening mistake — a deviation or
  end-of-theory eval-drop, not yet marked reviewed
  (**"Review K opening mistakes"**). When both apply the label
  surfaces both, joined by "·". → `/games`.
- **Onboarding** actions for new users (e.g. link an account when none
  is linked) — added incrementally.

### Import repertoire (PGN)

A lower-priority onboarding affordance rendered at the **bottom** of the
tile, below the action rows: a single row of compact, de-emphasized
buttons that import a repertoire from a `.pgn` file.

- A color's button (**"Import White PGN"** / **"Import Black PGN"**) is
  shown **only while that color's repertoire is empty**. Once a color has
  any positions, its button drops away — so a user who has built White is
  invited to import Black only, and a user with both built sees no import
  row.
- Because the import targets an empty color it is purely additive: the
  PGN is decoded and saved through the same pipeline as the Explorer
  Edit-mode import, then the dashboard re-fetches so the new cards (and
  the now-non-empty color) are reflected immediately.
- Picking a file whose `[Repertoire]` header disagrees with the chosen
  color is rejected with an inline error; success shows a brief
  confirmation.
- The import row also keeps the tile useful for a brand-new user who has
  nothing due and no repertoire — it shows in place of the "all caught
  up" empty state, which only appears when there is **nothing to do and
  nothing to import**.

## Deferred

- **Ordering and any cap** on how many actions show. For now show all
  applicable actions, with Start Training primary.
