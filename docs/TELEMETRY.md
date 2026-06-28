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
| `SettingsLichessConnected` | User links a Lichess account on the Settings page (OAuth connect completes). |
| `SettingsLichessDisconnected` | User unlinks their Lichess account on the Settings page. |
| `SettingsBackupExport` | User exports a repertoire backup file. |
| `SettingsBackupImport` | User imports a repertoire backup file. |
| `GamesMistakeReviewed` | User marks a game as reviewed on the Games page. |
| `GamesMistakeUnreviewed` | User clears the reviewed flag on a game on the Games page. |
| `GamesOpenInExplorer` | User opens an in-repertoire move from a game in the Explorer. |
| `GamesOpponentAnalysisStart` | Opponent analysis run begins for a deviation. |
| `GamesOpponentAnalysisComplete` | Opponent analysis run finishes successfully. |
| `GamesFixSuggested` | A suggested fix line is produced for a deviation. |
| `GamesSuggestedLineAdded` | User clicks "Add to repertoire" on a suggested fix. |
| `DashboardView` | Dashboard page loads (logged-in home). |
| `BootstrapStarted` | Repertoire-bootstrap page begins collecting games. |
| `BootstrapCompleted` | Bootstrap selection finishes (`gamesAnalyzed`, `linesProposed`). |
| `BootstrapReviewOpened` | User clicks "Proceed to review" on the post-analysis summary; hands the proposed lines to Explorer's Review & Save view (`gamesAnalyzed`, `linesProposed`). |

`GamesOpponentAnalysisStart` and `GamesOpponentAnalysisComplete` share an `AnalysisId` property so a completion can be linked back to its start (a start with no matching completion is an aborted or failed run).
