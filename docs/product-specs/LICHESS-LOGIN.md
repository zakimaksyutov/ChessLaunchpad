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

## Failure & cancellation

Any failure or cancellation — the user denies on Lichess, the token
can't be obtained or exchanged, or account creation fails — returns to the
Login page with the pending intent and any partial session cleared and a
single generic error. A session is only ever established after the
exchange succeeds, so a refresh can't resume a half-finished login.

## Session

- The **backend** token is the credential for all account and repertoire
  requests. The **Lichess** OAuth connection acquired at login is
  persisted (the existing OAuth mechanism already does this) and stays
  live for the session: it both feeds the backend exchange and authorizes
  direct Lichess API calls — notably authenticated Masters Opening
  Explorer queries, which get higher rate limits.
- A Lichess session persists across reloads in `localStorage`, mirroring
  how an email account stores `username` + `hashedPassword` today. It
  records that the session is Lichess-mode plus its id, cased display
  name, and the backend JWT, and is restored on startup so refresh keeps
  the user signed in.
- The Lichess OAuth token itself is also persisted in `localStorage` and
  restored on startup — the same mechanism already used when an email
  account links Lichess in Settings. Nothing new is needed for it.
- The repertoire data layer becomes auth-mode aware: password sessions
  keep sending the password as `Authorization`; Lichess sessions send
  `Bearer <token>`. Everything downstream (session cache, ETag/`If-Match`
  concurrency, repertoire blob shape, all pages) is unchanged.

## Linked accounts & Settings

- On **account creation** (the first-ever Lichess sign-in), the app seeds
  Linked Accounts with this account (platform `lichess`, the account's id)
  so the user's own games are ingested with no manual entry. This happens
  **only at creation**, never on subsequent sign-ins — thereafter it is an
  ordinary, fully removable linked account, and if the user removes it in
  Settings it stays removed (no silent re-add on the next login).
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
