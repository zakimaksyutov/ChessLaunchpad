# Telemetry

ChessLaunchpad sends telemetry to **Azure Application Insights**. All custom events go through the single `trackEvent(name)` helper in `app/src/AppInsights.ts`. Automatic collection (route/page-view tracking, AJAX/fetch tracking) is **disabled** — only the events below are emitted.

## Events

| Event | Emitted from | Trigger |
|-------|--------------|---------|
| `AppLoad` | `App.tsx` | App mounts (initial load). |
| `UserLogin` | `pages/LoginPage.tsx` | Successful sign-in to an existing account (password or Lichess). |
| `UserSignUp` | `pages/LoginPage.tsx` | Successful account creation (password or Lichess). |
| `UserLogout` | `App.tsx` | User logs out. |

None of these events carry custom properties.
