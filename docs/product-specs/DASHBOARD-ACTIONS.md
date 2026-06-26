# Dashboard Actions Tile — Product Specification

> Status: **proposed** (not yet implemented). Describes intended
> behavior. Supersedes the standalone "Start Training" call-to-action
> described in [`DASHBOARD.md`](./DASHBOARD.md) §1.5.

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

## Deferred

- **Ordering and any cap** on how many actions show. For now show all
  applicable actions, with Start Training primary.
