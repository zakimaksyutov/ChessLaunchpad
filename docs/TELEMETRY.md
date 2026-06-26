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
