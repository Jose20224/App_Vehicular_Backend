import * as Sentry from '@sentry/nestjs';

const dsn = process.env.SENTRY_DSN?.trim();
if (dsn) {
  const sample = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.05');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.05,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, queues: false, stackFrameVariables: false },
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.data;
        delete event.request.query_string;
        if (event.request.url) event.request.url = event.request.url.split('?')[0].replace(/(assistance-actions\/)[^/]+/g, '$1[redacted]');
        delete event.request.headers;
      }
      for (const exception of event.exception?.values ?? []) exception.value = '[redacted]';
      delete event.extra;
      for (const breadcrumb of event.breadcrumbs ?? []) {
        if (breadcrumb.data) {
          delete breadcrumb.data.request;
          delete breadcrumb.data.response;
          delete breadcrumb.data.data;
          if (typeof breadcrumb.data.url === 'string') breadcrumb.data.url = breadcrumb.data.url.split('?')[0].replace(/(assistance-actions\/)[^/]+/g, '$1[redacted]');
        }
      }
      for (const span of event.spans ?? []) {
        if (span.description) span.description = span.description.replace(/(assistance-actions\/)[^/]+/g, '$1[redacted]');
        if (span.data) {
          delete span.data['http.url'];
          delete span.data.url;
        }
      }
      return event;
    },
  });
}
