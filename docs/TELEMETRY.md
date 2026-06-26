# Telemetry

ChessLaunchpad sends telemetry to **Azure Application Insights**. All custom events go through the single `trackEvent(name)` helper in `app/src/AppInsights.ts`. Automatic collection (route/page-view tracking, AJAX/fetch tracking) is **disabled** — only the events below are emitted.

## Events

| Event | Trigger |
|-------|---------|
| `AppLoad` | App mounts (initial load). |
| `UserLogin` | Successful sign-in to an existing account (password or Lichess). |
| `UserSignUp` | Successful account creation (password or Lichess). |
| `UserLogout` | User logs out. |
| `UserDelete` | User permanently deletes their account. |
| `SettingsReset` | User clicks "Reset to Defaults" on the Settings page. |
| `SettingsSaved` | User saves changes on the Settings page. |
| `LichessConnected` | User links a Lichess account on the Settings page (OAuth connect completes). |
| `LichessDisconnected` | User unlinks their Lichess account on the Settings page. |
| `BackupExport` | User exports a repertoire backup file. |
| `BackupImport` | User imports a repertoire backup file. |
| `MistakeReviewed` | User marks a game as reviewed on the Games page. |
| `MistakeUnreviewed` | User clears the reviewed flag on a game on the Games page. |
| `MistakeOpenInExplorer` | User opens an in-repertoire move from a game in the Explorer. |
| `OpponentAnalysisStart` | Opponent analysis run begins for a deviation. |
| `OpponentAnalysisComplete` | Opponent analysis run finishes successfully. |
| `FixSuggested` | A suggested fix line is produced for a deviation. |
| `SuggestedLineAdded` | User clicks "Add to repertoire" on a suggested fix. |
| `DashboardView` | Dashboard page loads (logged-in home). |

`OpponentAnalysisStart` and `OpponentAnalysisComplete` share an `AnalysisId` property so a completion can be linked back to its start (a start with no matching completion is an aborted or failed run).
