# Chess Launchpad — Backend API Contract

Base URL: `https://<host>/api`

Account and repertoire endpoints require an `Authorization` header. Two authorization modes are supported:

- **Username/password auth:** `Authorization: <password>` for accounts created with a caller-chosen password.
- **Lichess auth:** `Authorization: Bearer <jwt>` for Lichess accounts. The token is issued by `POST /auth/lichess` and authorizes requests for the returned Lichess user ID.

The reserved `lichess:` prefix cannot be used for username/password account IDs. Lichess clients use the plain lowercased Lichess user ID in URLs.

CORS is enabled for all origins (`*`).

---

## Common Headers

### Request Headers

| Header          | Required | Description |
| --------------- | -------- | ----------- |
| `Authorization` | Varies   | Required for account and repertoire endpoints. Use either a username/password account password or `Bearer <jwt>`. Not required for CORS preflight. |
| `If-Match`      | Varies   | ETag for optimistic concurrency (required on `PUT /variants`). |
| `Content-Type`  | Varies   | `application/json` when sending a request body. |

### Response Headers

All successful responses include these CORS headers:

| Header                             | Value                                    |
| ---------------------------------- | ---------------------------------------- |
| `Access-Control-Allow-Origin`      | `*`                                      |
| `Access-Control-Allow-Methods`     | `GET,PUT,POST,OPTIONS,DELETE`            |
| `Access-Control-Allow-Headers`     | `Authorization,If-Match,Content-Type`    |
| `Access-Control-Expose-Headers`    | `ETag`                                   |

The `ETag` response header is returned by `GET` and `PUT` on the variants endpoint.

---

## Endpoints

### Lichess Login

```
POST /auth/lichess
```

Exchanges a Lichess OAuth token for a Chess Launchpad token. This endpoint validates the Lichess token but does **not** create a user account. The client should call `PUT /user/{userId}` with the returned `jwt` and `userId` when account creation is needed.

**Request:**

```json
{ "token": "lip_..." }
```

**Responses:**

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | `{ "jwt": "<token>", "userId": "<lichessUserId>" }` | Success. The token authorizes the returned `userId`. |
| 400 | error msg | Missing token or malformed JSON. |
| 401 | error msg | Lichess token invalid/expired. |
| 502 | error msg | Lichess unreachable. |
| 500 | *(empty)* | Internal server error. |

### Create User

```
PUT /user/{userId}
```

Creates a new user account.

For username/password accounts, the `Authorization` header value is the user's password for future requests.

For Lichess accounts, send `Authorization: Bearer <jwt>`. The token must authorize the requested `{userId}`.

The `lichess:` prefix is reserved and cannot be used as a username/password account ID.

**Request:**
- No body required.

**Responses:**

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | `User '{userId}' has been created.` | User created successfully. |
| 400 | error msg | Reserved user ID prefix. |
| 401 | error msg | Missing authorization, or token invalid/expired. |
| 403 | error msg | Credential does not authorize the requested user. |
| 409 | `User '{userId}' already exists.` | userId is already taken. |
| 500 | *(empty)* | Internal server error. |

---

### Delete User

```
DELETE /user/{userId}
```

Permanently deletes a user and all their data.

Username/password accounts use `Authorization: <password>`. Lichess-auth accounts use `Authorization: Bearer <jwt>`. The credential must authorize the requested `{userId}`.

**Request:**
- No body.

**Responses:**

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | `User '{userId}' has been successfully deleted.` | Deleted. |
| 400 | error msg | Reserved user ID prefix. |
| 401 | error msg | Missing authorization, or token invalid/expired. |
| 403 | error msg | Credential does not authorize the requested user. |
| 404 | `User '{userId}' does not exist.` | No such user. |
| 500 | *(empty)* | Internal server error. |

---

### Retrieve Variants

```
GET /user/{userId}/variants
```

Returns the user's full repertoire as JSON.

Username/password accounts use `Authorization: <password>`. Lichess-auth accounts use `Authorization: Bearer <jwt>`. The credential must authorize the requested `{userId}`.

**Responses:**

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | Repertoire JSON (see schema below) | Success. `ETag` header is set. |
| 400 | error msg | Reserved user ID prefix. |
| 401 | error msg | Missing authorization, or token invalid/expired. |
| 403 | error msg | Credential does not authorize the requested user. |
| 404 | `User '{userId}' does not exist.` | No such user. |
| 500 | *(empty)* | Internal server error. |

The `ETag` response header must be saved and sent back as `If-Match` when updating.

---

### Update Variants

```
PUT /user/{userId}/variants
```

Replaces the user's entire repertoire. Uses optimistic concurrency — the `If-Match` header must carry the ETag received from the most recent `GET` or `PUT`.

Username/password accounts use `Authorization: <password>`. Lichess-auth accounts use `Authorization: Bearer <jwt>`. The credential must authorize the requested `{userId}`.

**Request:**
- Body: Repertoire JSON (see schema below).
- `If-Match` header: Required.

**Responses:**

| Status | Body | Meaning |
| ------ | ---- | ------- |
| 200 | `Variants updated successfully.` | Success. New `ETag` header is set. |
| 400 | Validation error message | Body is empty, not valid JSON, exceeds 1 MiB, `If-Match` is missing, or user ID uses a reserved prefix. |
| 401 | error msg | Missing authorization, or token invalid/expired. |
| 403 | error msg | Credential does not authorize the requested user. |
| 404 | `User '{userId}' does not exist.` | No such user. |
| 412 | `{ "message": "If-Match: '{value}'" }` | ETag mismatch — re-fetch and retry. |
| 500 | *(empty)* | Internal server error. |

---

### CORS Preflight

```
OPTIONS /auth/lichess
OPTIONS /user/{userId}
OPTIONS /user/{userId}/variants
```

Returns `200 OK` with CORS headers. No `Authorization` required.

---

## Repertoire JSON Body

> **⚠️ Note:** The backend does **not** enforce any schema on the repertoire body. The
> only server-side checks on `PUT /variants` are that the body is **non-empty valid JSON**
> and **at most 1 MiB** (1,048,576 bytes, measured as UTF-8). Any valid JSON document
> within that size limit is accepted unchanged. The example below is a
> **non-normative** illustration of the shape the client currently produces and consumes;
> it is not validated by the server and may evolve freely.

A newly created user starts with `{}`.

### Example

```json
{
  "data": [
    {
      "pgn": "1. e4 e5 2. Nf3 Nc6 3. Bc4",
      "orientation": "white",
      "classifications": ["Italian Game"],
      "errorEMA": 0.15,
      "numberOfTimesPlayed": 42,
      "lastSucceededEpoch": 80,
      "successEMA": 0.85
    }
  ],
  "currentEpoch": 81,
  "lastPlayedDate": "2025-05-17T00:00:00.000Z",
  "dailyPlayCount": 12,
  "weightSettings": {
    "recencyPower": 1.5,
    "frequencyPower": 2,
    "errorPower": 0.75
  },
  "fsrsCards": {
    "pos1": {"d":"2026-05-01T00:00:00.000Z","s":15.23,"di":5.68,"e":3,"sd":7,"ls":0,"r":12,"l":2,"st":2,"lr":"2026-04-19T00:00:00.000Z"}
  },
  "settings": {
    "contextDepth": 2,
    "retention": 0.97,
    "maxInterval": 90
  }
}
```

---

## Error Handling

- **400** — Request body is empty, not valid JSON, or exceeds the 1 MiB size limit. The response body contains a human-readable message describing the problem. No structural/schema validation is performed.
- **412** — Optimistic concurrency conflict. The client should re-fetch the resource to get the latest ETag, then retry the update.
- **500** — Unexpected server error. Details are logged server-side only.
