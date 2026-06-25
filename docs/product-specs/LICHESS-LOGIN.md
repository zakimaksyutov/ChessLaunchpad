# Lichess Login — Product Specification

Let users sign in with their Lichess account as an alternative to the
existing username/password accounts. Both kinds of account use the same
repertoire backend and behave identically once signed in.

## Identity

- A Lichess account's user id **is** the lowercased Lichess username; it
  is the same id used in all backend URLs and as the auth identity.
- For display, use the user's **properly-cased Lichess username** (what
  they see on Lichess), not the lowercased id. The session therefore
  carries both: the lowercased id for the backend, the cased name for UI.
- Lichess accounts and username/password accounts share one namespace but
  cannot collide: the backend reserves the `lichess:` prefix and rejects
  it for password accounts.

## Flow

1. User picks **Sign in with Lichess** on the Login page.
2. The app reuses the existing Lichess OAuth (PKCE) connection to obtain a
   Lichess token. This is a full-page redirect to Lichess and back, so the
   login completes *after* the app reloads — a pending "finish Lichess
   login" intent must survive the redirect and resume on return.
3. The app exchanges the Lichess token with the backend
   (`POST /auth/lichess`) and receives a backend-issued token plus the
   resolved user id; it also captures the user's cased Lichess username.
4. First-ever sign-in creates the backend account (the exchange does not);
   an "already exists" result is treated as a normal sign-in.
5. The app establishes a session from the backend token and lands on the
   same post-login page as username/password.

## Session

- The backend token is the credential for **all** account and repertoire
  requests; the Lichess token is only ever used for the exchange.
- A Lichess session persists across reloads the same way a
  username/password session does today (survives refresh, restored on
  startup), recording that it is a Lichess session plus its id and cased
  display name.
- The repertoire data layer becomes auth-mode aware: password sessions
  keep sending the password as `Authorization`; Lichess sessions send
  `Bearer <token>`. Everything downstream (session cache, ETag/`If-Match`
  concurrency, repertoire blob shape, all pages) is unchanged.

## Linked accounts & Settings

- A Lichess login is, by definition, a connected Lichess account, so the
  app **auto-adds it to Linked Accounts** (platform `lichess`, the
  account's id) on sign-in if not already present, so the user's own games
  are ingested with no manual entry. It otherwise behaves like any linked
  account.
- The Settings **"Lichess Integration"** connect/disconnect section is for
  separately attaching Lichess to a username/password account. For a
  Lichess-login session it is redundant and must be **hidden** — the login
  already is the connection.

## Token lifecycle

- The backend token can expire. When a backend call is rejected as
  unauthorized, transparently re-run the exchange to get a fresh token and
  retry once.
- If the underlying Lichess connection is gone/expired and cannot be
  refreshed, drop the session and return the user to Login.

## Logout

- Logout from a Lichess session clears the backend token and the app
  session (same end state as username/password logout: back to the landing
  page, no cached repertoire), **and** disconnects the underlying Lichess
  OAuth connection (revoking the Lichess token), since for a Lichess login
  that connection *is* the sign-in. The next login therefore starts fresh.

## UI

- Login page offers **Sign in with Lichess** alongside the existing
  username/password form.
- The header and anywhere the signed-in user is shown use the cased
  Lichess display name; the rest of the app works without special-casing.

## Non-goals

- No merging/linking a Lichess login with an existing username/password
  account.
- No change to the repertoire data model, sync, or any page beyond auth.
