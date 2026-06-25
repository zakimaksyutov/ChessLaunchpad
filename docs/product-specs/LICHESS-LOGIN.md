# Lichess Login — Product Specification

Let users sign in with their Lichess account as an alternative to the
existing username/password accounts. Both kinds of account use the same
repertoire backend and behave identically once signed in.

## Identity

- A Lichess account's user id **is** the lowercased Lichess username; it
  is the same id used in all backend URLs.
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
   resolved user id.
4. First-ever sign-in creates the backend account (the exchange does not);
   an "already exists" result is treated as a normal sign-in.
5. The app establishes a session from the backend token and lands on the
   same post-login page as username/password.

## Session

- The backend token is the credential for **all** account and repertoire
  requests; the Lichess token is only ever used for the exchange.
- A Lichess session persists across reloads the same way a
  username/password session does today (survives refresh, restored on
  startup), recording that it is a Lichess session and its user id.
- The repertoire data layer becomes auth-mode aware: password sessions
  keep sending the password as `Authorization`; Lichess sessions send
  `Bearer <token>`. Everything downstream (session cache, ETag/`If-Match`
  concurrency, repertoire blob shape, all pages) is unchanged.

## Token lifecycle

- The backend token can expire. When a backend call is rejected as
  unauthorized, transparently re-run the exchange to get a fresh token and
  retry once.
- If the underlying Lichess connection is gone/expired and cannot be
  refreshed, drop the session and return the user to Login.
- Logout clears the cached backend token and session like today.

## UI

- Login page offers **Sign in with Lichess** alongside the existing
  username/password form.
- Signed-in identity shown in the header is the Lichess user id; the rest
  of the app (Settings, logout, etc.) works without special-casing.

## Non-goals

- No merging/linking a Lichess login with an existing username/password
  account.
- No change to the repertoire data model, sync, or any page beyond auth.
