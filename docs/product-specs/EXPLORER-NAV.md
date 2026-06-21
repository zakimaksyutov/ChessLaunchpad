# Explorer — Navigation Controls

Change to the **"How you got here"** section on `/explorer`.

## Goal

Replace the text **"start"** button with a compact icon toolbar —
**Home · Back · Forward** — and give the Explorer its own in-page
position history so Back/Forward step through positions the user
visited inside `/explorer`.

Match the button styling as closely as possible to this reference
(local-only asset, not committed to git):

![Explorer nav controls reference](./local-assets/explorer-nav-controls.jpg)

## Controls

- **Home** (🏠): jumps to the start position — today's "start"
  behavior. Inactive when already at start.
- **Back** (‹) / **Forward** (›): move through the Explorer's own
  history of viewed positions. Each is disabled at its end of the
  stack; Forward only lights up after a Back.
- **Placement:** a small icon row leading the "How you got here" line,
  where the "start" pill sits today.

## History behavior

- Every position change inside `/explorer` records an entry — clicking
  a ply/move, playing a board move, Home, Find position, orientation
  toggle.
- Navigating somewhere new after a Back truncates the forward entries
  (standard browser semantics).
- Back/Forward restore the exact position **and orientation** of that
  entry without recording a new entry.
- History is in-memory, per tab; it survives Edit mode (entering/
  exiting doesn't clear it) and is dropped on reload or leaving
  `/explorer`. It is not encoded in the URL or shared links.
- These are independent in-page controls; browser Back, Refresh, and
  link-sharing keep working via the URL exactly as today.

## Open Questions

1. Should in-page Back/Forward reuse the **browser** history stack (so
   they stay in sync with the browser Back button) or a **separate
   internal** stack? — *Assumed separate internal stack.*
2. On orientation toggle, is history one combined timeline across both
   sides (*assumed*) or reset per side?
3. Keyboard shortcuts (e.g. Alt+←/→)? — *Assumed none.*
