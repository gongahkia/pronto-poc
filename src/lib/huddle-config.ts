import type { HuddleOptions } from '@huddle/browser/react';

// Read on the server (including the request proxy). Only these public fields
// cross the client boundary; Huddle credentials never come from Pronto.
export type HuddleReviewConfig = Pick<HuddleOptions, 'serverUrl' | 'projectId' | 'environment' | 'release'>;

export function huddleReviewConfig(env: NodeJS.ProcessEnv = process.env): HuddleReviewConfig | null {
  if (env.PRONTO_HUDDLE_ENABLED !== '1' || env.PRONTO_CUSTOMER_DEMO_ENABLED !== '1') return null;
  try {
    const url = new URL(env.PRONTO_HUDDLE_SERVER_URL?.trim() ?? '');
    const localHttp = env.NODE_ENV !== 'production' && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    const projectId = env.PRONTO_HUDDLE_PROJECT_ID?.trim() ?? '';
    const environment = env.PRONTO_HUDDLE_ENVIRONMENT?.trim() || 'development';
    const release = env.PRONTO_HUDDLE_RELEASE?.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId) ||
        !/^[a-z0-9_-]{1,40}$/.test(environment) || (release && release.length > 120)) return null;
    return { serverUrl: url.origin, projectId, environment, ...(release ? { release } : {}) };
  } catch { return null; }
}
