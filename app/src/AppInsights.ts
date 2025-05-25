import { ApplicationInsights } from '@microsoft/applicationinsights-web';

let isAppInsightsLoaded = false;

const appInsights = new ApplicationInsights({
  config: {
    connectionString: process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING,
    disableAjaxTracking: true,
    disableCorrelationHeaders: true,
    disableFetchTracking: true,
    enableAutoRouteTracking: false
  }
});

try {
  appInsights.loadAppInsights();
  appInsights.context.application.ver = process.env.REACT_APP_BUILD_VERSION || 'unknown';
  isAppInsightsLoaded = true;
  console.log('Application Insights loaded successfully');
} catch (error) {
  isAppInsightsLoaded = false;
  console.error('Error loading Application Insights:', error);
}

export const trackEvent = (name: string, customProperties?: { [key: string]: any }) => {
  if (isAppInsightsLoaded) {
    appInsights.trackEvent(
      { name },
      customProperties
    );
  }
};

export const setAuthenticatedUserContext = (authenticatedUserId: string, accountId?: string) => {
  if (isAppInsightsLoaded) {
    appInsights.setAuthenticatedUserContext(authenticatedUserId, accountId);
  }
};

export const clearAuthenticatedUserContext = () => {
  if (isAppInsightsLoaded) {
    appInsights.clearAuthenticatedUserContext();
  }
};

export default appInsights; 