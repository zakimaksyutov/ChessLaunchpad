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
| `GamesKeepPlayedMove` | User clicks "keep playing X" on an early-divergence fix, resuming the walk from the kept move. |
| `GamesSuggestedLineAdded` | User clicks "Add to repertoire" on a suggested fix. |
| `DashboardView` | Dashboard page loads (logged-in home). |
| `BootstrapStarted` | Repertoire-bootstrap page begins collecting games. |
| `BootstrapCompleted` | Bootstrap selection finishes (`gamesAnalyzed`, `linesProposed`). |
| `BootstrapSaved` | User clicks "Save & start training" on the post-analysis summary; the proposed lines are persisted directly and the user is sent to `/training` (`gamesAnalyzed`, `linesProposed`, `added`). |
| `BootstrapReviewOpened` | User clicks "Review & edit lines first" on the post-analysis summary; hands the proposed lines to Explorer's Review & Save view (`gamesAnalyzed`, `linesProposed`). |
| `BootstrapDismissed` | User clicks "Not now" on the post-analysis summary; returns to the Dashboard without saving. The analysis stays cached in memory so re-entering `/bootstrap` restores the summary (`gamesAnalyzed`, `linesProposed`). |
| `ExplorerEditStarted` | User enters Explorer Edit mode via the "Edit repertoire" button (manual edit session). |
| `ExplorerReviewOpened` | User opens the Explorer "Review & Save" view from a manual edit (`source`, `added`, `removed`, `changed`). |
| `ExplorerSaved` | A pending Explorer edit is persisted successfully (`source`, `added`, `removed`, `changed`). |
| `ExplorerEditDiscarded` | User discards a pending Explorer edit (`source`, `added`, `removed`, `changed`; all-zero counts mean Edit mode was exited with no staged changes). |
| `ExplorerSaveConflict` | An Explorer Save was rejected by a concurrent-edit conflict (HTTP 412); the app prompts the user to reload and lose local edits (`source`). |
| `ExplorerSaveFailed` | An Explorer Save failed for a non-conflict reason (`source`, `statusCode`). |
| `ExplorerImportPgn` | User stages a PGN into the pending Explorer edit via paste or file (`source`, `orientation`, `addedEdges`, `replacedAnnotations`). |
| `ExplorerExportPgn` | User exports the current orientation's repertoire as a `.pgn` file from Explorer (`orientation`, `positionCount`). |
| `ExplorerOpenInLichess` | User opens the displayed line on the Lichess analysis board from Explorer (`orientation`). |
| `TrainingSessionStarted` | First live traversal of a `/training` visit begins (one per visit, fired only when there are cards to drill) (`dueCount`, `newCount`, `reviewCount`, `learningCount`, `totalCards`). |
| `TrainingSessionCompleted` | The due queue drains after real training and the "All due cards reviewed" panel renders (`reviewedToday`). |
| `TrainingKeepPracticing` | User clicks "Practice ahead of schedule" on the session-complete panel to keep drilling past the due queue. |
| `TrainingSaveConflict` | A training traversal save was rejected by a concurrent-edit conflict (HTTP 412); the app prompts the user to reload. |
| `TrainingSaveFailed` | A training traversal save failed for a non-conflict reason (`statusCode`). |
| `TrainingEmptyRedirect` | User opens `/training` with no trainable positions and is redirected to the Dashboard. |

`GamesOpponentAnalysisStart` and `GamesOpponentAnalysisComplete` share an `AnalysisId` property so a completion can be linked back to its start (a start with no matching completion is an aborted or failed run).

The Explorer edit/save events carry a `source` property — `manual` (the "Edit repertoire" button), `bootstrap` (the `/bootstrap` starter-repertoire handoff), or `gamesSuggest` (the `/games` "Add to repertoire" suggestion) — identifying which funnel initiated the edit session. This lets `ExplorerSaved` close the funnels that previously ended at `BootstrapReviewOpened` and `GamesSuggestedLineAdded`/`GamesOpenInExplorer`. The `added`/`removed`/`changed` counts mirror the Review & Save bar; a delete that cascades through a branch counts every removed edge.

The Training events are scoped to a single `/training` visit. `TrainingSessionStarted` and `TrainingSessionCompleted` each fire at most once per visit, and `TrainingSessionCompleted` only when real training preceded the drain (arriving already caught-up shows the same panel but stays silent). There is intentionally **no per-card or per-traversal event** — those would be far too high-volume for the single FSRS review loop; session-level aggregates are used instead.


