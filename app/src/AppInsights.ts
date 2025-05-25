import { ApplicationInsights } from '@microsoft/applicationinsights-web';

const appInsights = new ApplicationInsights({
  config: {
    connectionString: process.env.REACT_APP_APPINSIGHTS_CONNECTION_STRING,
    disableAjaxTracking: true,
    disableCorrelationHeaders: true,
    disableFetchTracking: true,
    enableAutoRouteTracking: false
  }
});

appInsights.loadAppInsights();
appInsights.context.application.ver = process.env.REACT_APP_BUILD_VERSION || 'unknown';

export const trackEvent = (name: string, customProperties?: { [key: string]: any }) => {
  appInsights.trackEvent(
    { name },
    customProperties
  );
};

export default appInsights; 