# Chess Launchpad — Backend API Contract

Base URL: `https://<host>/api`

All endpoints require an `Authorization` header containing the user's secret (established at account creation).

CORS is enabled for all origins (`*`).

---

## Common Headers

### Request Headers

| Header          | Required | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `Authorization` | Yes      | The user's secret (established at account creation). |
| `If-Match`      | Varies   | ETag for optimistic concurrency (required on `PUT /variants`). |
| `Content-Type`  | Varies   | `application/json` when sending a request body.          |

### Response Headers

All successful responses include these CORS headers:

| Header                             | Value                                    |
| ---------------------------------- | ---------------------------------------- |
| `Access-Control-Allow-Origin`      | `*`                                      |
| `Access-Control-Allow-Methods`     | `GET,PUT,OPTIONS,DELETE`                 |
| `Access-Control-Allow-Headers`     | `Authorization,If-Match,Content-Type`    |
| `Access-Control-Expose-Headers`    | `ETag`                                   |

The `ETag` response header is returned by `GET` and `PUT` on the variants endpoint.

---

## Endpoints

### Create User

```
PUT /user/{userId}
```

Creates a new user account. The `Authorization` header value becomes the user's secret for all future requests.

**Request:**
- No body required.

**Responses:**

| Status | Body                                | Meaning                    |
| ------ | ----------------------------------- | -------------------------- |
| 200    | `User '{userId}' has been created.` | User created successfully. |
| 401    | `Missing Authorization header.`     | No `Authorization` header. |
| 409    | `User '{userId}' already exists.`   | userId is already taken.   |
| 500    | *(empty)*                           | Internal server error.     |

---

### Delete User

```
DELETE /user/{userId}
```

Permanently deletes a user and all their data.

**Request:**
- No body.

**Responses:**

| Status | Body                                              | Meaning                       |
| ------ | ------------------------------------------------- | ----------------------------- |
| 200    | `User '{userId}' has been successfully deleted.`  | Deleted.                      |
| 401    | `Missing Authorization header.`                   | No `Authorization` header.    |
| 403    | `Wrong secret.`                                   | Secret doesn't match.         |
| 404    | `User '{userId}' does not exist.`                 | No such user.                 |
| 500    | *(empty)*                                         | Internal server error.        |

---

### Retrieve Variants

```
GET /user/{userId}/variants
```

Returns the user's full repertoire as JSON.

**Responses:**

| Status | Body                                | Meaning                    |
| ------ | ----------------------------------- | -------------------------- |
| 200    | Repertoire JSON (see schema below)  | Success. `ETag` header is set. |
| 401    | `Missing Authorization header.`     | No `Authorization` header. |
| 403    | `Wrong secret.`                     | Secret doesn't match.      |
| 404    | `User '{userId}' does not exist.`   | No such user.              |
| 500    | *(empty)*                           | Internal server error.     |

The `ETag` response header must be saved and sent back as `If-Match` when updating.

---

### Update Variants

```
PUT /user/{userId}/variants
```

Replaces the user's entire repertoire. Uses optimistic concurrency — the `If-Match` header must carry the ETag received from the most recent `GET` or `PUT`.

**Request:**
- Body: Repertoire JSON (see schema below).
- `If-Match` header: Required.

**Responses:**

| Status | Body                                           | Meaning                              |
| ------ | ---------------------------------------------- | ------------------------------------ |
| 200    | `Variants updated successfully.`               | Success. New `ETag` header is set.   |
| 400    | Validation error message                       | Body failed schema validation.       |
| 401    | `Missing Authorization header.`                | No `Authorization` header.           |
| 403    | `Wrong secret.`                                | Secret doesn't match.                |
| 404    | `User '{userId}' does not exist.`              | No such user.                        |
| 412    | `{ "message": "If-Match: '{value}'" }`         | ETag mismatch — re-fetch and retry.  |
| 500    | *(empty)*                                      | Internal server error.               |

---

### CORS Preflight

```
OPTIONS /user/{userId}
OPTIONS /user/{userId}/variants
```

Returns `200 OK` with CORS headers. No `Authorization` required.

---

## Repertoire JSON Schema

A newly created user starts with `{}`. After the first update, the repertoire must conform to the following schema.

### Root Object

| Property          | Type     | Required | Description                                    |
| ----------------- | -------- | -------- | ---------------------------------------------- |
| `data`            | array    | Yes      | Array of opening items (max **500**).          |
| `currentEpoch`    | number   | Yes      | Current training epoch counter.                |
| `lastPlayedDate`  | string   | Yes      | ISO 8601 date string (max 256 chars).          |
| `dailyPlayCount`  | number   | Yes      | Number of plays today.                         |
| `weightSettings`  | object \| null | No | Weight configuration (see below). May be `null` or omitted. |
| `fsrsCards`       | object \| null | No | Map of FSRS card states keyed by string. May be `null` or omitted. |
| `settings`        | object \| null | No | Training configuration (free-form object). May be `null` or omitted. |
| `activity`        | object \| null | No | Activity data (free-form object). May be `null` or omitted. |
| `games`           | object \| null | No | Games data (free-form object). May be `null` or omitted. |

No additional properties are allowed on the root object.

### Data Item

Each element in the `data` array:

| Property              | Type     | Required | Constraints                            |
| --------------------- | -------- | -------- | -------------------------------------- |
| `pgn`                 | string   | Yes      | Non-empty. Max **1024** characters.    |
| `orientation`         | string   | Yes      | Must be `"white"` or `"black"`.        |
| `classifications`     | array    | Yes      | Array of non-empty strings (max **20** items, each max 256 chars). |
| `errorEMA`            | number   | Yes      | Exponential moving average of errors.  |
| `numberOfTimesPlayed` | number   | Yes      | Total play count for this opening.     |
| `lastSucceededEpoch`  | number   | Yes      | Epoch of last successful attempt.      |
| `successEMA`          | number   | Yes      | Exponential moving average of successes. |

No additional properties are allowed on data items. Each item must have exactly these 7 properties.

### Weight Settings

When present and non-null:

| Property         | Type   | Required | Description                        |
| ---------------- | ------ | -------- | ---------------------------------- |
| `recencyPower`   | number | Yes      | Weight exponent for recency.       |
| `frequencyPower` | number | Yes      | Weight exponent for frequency.     |
| `errorPower`     | number | Yes      | Weight exponent for error rate.    |

No additional properties are allowed. Must have exactly these 3 properties.

### FSRS Card Entry

When `fsrsCards` is present and non-null, it must be a JSON object. Each key must be a non-empty string (max 256 characters). Each value must conform to:

| Minified Key | Full Name        | Type   | Required | Constraints                                      |
| ------------ | ---------------- | ------ | -------- | ------------------------------------------------ |
| `d`          | due              | string | Yes      | Non-empty. Max 256 characters. ISO 8601 date.    |
| `s`          | stability        | number | Yes      | FSRS stability parameter.                        |
| `di`         | difficulty       | number | Yes      | FSRS difficulty parameter.                       |
| `e`          | elapsed_days     | number | Yes      | Days since last review.                          |
| `sd`         | scheduled_days   | number | Yes      | Days until next scheduled review.                |
| `ls`         | learning_steps   | number | Yes      | Current learning step index.                     |
| `r`          | reps             | number | Yes      | Total review count.                              |
| `l`          | lapses           | number | Yes      | Number of times the card lapsed.                 |
| `st`         | state            | number | Yes      | Must be `0` (New), `1` (Learning), `2` (Review), or `3` (Relearning). |
| `lr`         | last_review      | string | No       | Non-empty. Max 256 characters. ISO 8601 date.    |

No additional properties are allowed. Each entry must have exactly 9 required properties, plus optionally `lr` (9 or 10 total).

### Settings

When present and non-null, `settings` must be a JSON object. Any properties are allowed inside (no strict schema validation on contents).

```json
{
  "settings": {
    "contextDepth": 2,
    "retention": 0.97,
    "maxInterval": 90
  }
}
```

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

- **400** — Request body failed validation. The response body contains a human-readable message describing the first validation error found.
- **412** — Optimistic concurrency conflict. The client should re-fetch the resource to get the latest ETag, then retry the update.
- **500** — Unexpected server error. Details are logged server-side only.
