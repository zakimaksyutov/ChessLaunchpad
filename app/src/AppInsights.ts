import { ApplicationInsights } from '@microsoft/applicationinsights-web';

// Application Insights configuration
const appInsights = new ApplicationInsights({
  config: {
    // Connection string - should be set via environment variable in production
    connectionString: process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING || '',
    
    // Disable automatic tracking but keep basic telemetry for custom events
    disableAjaxTracking: true,
    disableExceptionTracking: true,
    disableFetchTracking: true,
    disableCorrelationHeaders: true,
    disableXhr: true,
    
    // Disable automatic page view tracking
    disablePageUnloadEvents: ['beforeunload', 'unload', 'pagehide'],
    autoTrackPageVisitTime: false,
    enableAutoRouteTracking: false,
    
    // Disable other automatic features
    enableUnhandledPromiseRejectionTracking: false,
    enableDebug: false,
    loggingLevelConsole: 0, // Disable console logging
    loggingLevelTelemetry: 0, // Disable telemetry logging
    
    // Performance and data collection settings - Enable for custom events
    samplingPercentage: 100, // Enable sampling for custom events
    maxBatchInterval: 15000, // Send batch every 15 seconds
    maxBatchSizeInBytes: 1024000, // 1MB batch size
    
    // Privacy and data settings
    isCookieUseDisabled: true,
    isStorageUseDisabled: true,
    
    // Additional disabled features
    enableSessionStorageBuffer: false,
    enablePerfMgr: false,
  }
});

// Export the instance for use
export default appInsights;

// Helper functions for when we want to enable specific features
export const initializeAppInsights = () => {
  if (process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING) {
    appInsights.loadAppInsights();
    
    // Set the build version
    appInsights.context.application.build = process.env.REACT_APP_BUILD_VERSION || 'unknown';

    console.log('Application Insights initialized');
  } else {
    console.log('Application Insights not initialized - no connection string provided');
  }
};
