import { ApplicationInsights } from '@microsoft/applicationinsights-web';

// Application Insights configuration
const appInsights = new ApplicationInsights({
  config: {
    // Connection string - should be set via environment variable in production
    connectionString: process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING || '',
    
    // Disable all telemetry for now
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
    
    // Performance and data collection settings
    samplingPercentage: 0, // Disable sampling (no data collection)
    maxBatchInterval: 0,
    maxBatchSizeInBytes: 0,
    
    // Privacy and data settings
    isCookieUseDisabled: true,
    isStorageUseDisabled: true,
    
    // Additional disabled features
    enableSessionStorageBuffer: false,
    enablePerfMgr: false,
  }
});

// Telemetry initializer to add build version to every telemetry item
const addBuildVersionToTelemetry = (envelope: any) => {
  const buildVersion = process.env.REACT_APP_BUILD_VERSION;
  if (buildVersion) {
    // Add build version to custom properties
    envelope.data = envelope.data || {};
    envelope.data.baseData = envelope.data.baseData || {};
    envelope.data.baseData.properties = envelope.data.baseData.properties || {};
    envelope.data.baseData.properties.buildVersion = buildVersion;
    
    // Also add to tags for easier filtering in Application Insights
    envelope.tags = envelope.tags || {};
    envelope.tags['ai.application.ver'] = buildVersion;
  }
  return true;
};

// Initialize but don't load yet since everything is disabled
// appInsights.loadAppInsights();

// Export the instance for potential future use
export default appInsights;

// Helper functions for when we want to enable specific features
export const initializeAppInsights = () => {
  if (process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING) {
    // Add the telemetry initializer before loading
    appInsights.addTelemetryInitializer(addBuildVersionToTelemetry);
    
    appInsights.loadAppInsights();
    console.log('Application Insights initialized with build version:', process.env.REACT_APP_BUILD_VERSION);
  } else {
    console.log('Application Insights not initialized - no connection string provided');
  }
};
