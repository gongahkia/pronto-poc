import { describe, expect, it } from 'vitest';
import { huddleReviewConfig } from '@/lib/huddle-config';

const enabled = { NODE_ENV: 'development', PRONTO_CUSTOMER_DEMO_ENABLED: '1', PRONTO_HUDDLE_ENABLED: '1',
  PRONTO_HUDDLE_SERVER_URL: 'http://localhost:4310', PRONTO_HUDDLE_PROJECT_ID: '11111111-1111-4111-8111-111111111111' };

describe('Huddle public installation configuration', () => {
  it('requires both explicit review and synthetic demo opt-ins', () => {
    expect(huddleReviewConfig({})).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_ENABLED: '0' })).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_CUSTOMER_DEMO_ENABLED: '0' })).toBeNull();
  });
  it('returns only validated public configuration', () => {
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_RELEASE: 'test-build', HUDDLE_ACCESS_TOKEN: 'private' })).toEqual({
      serverUrl: 'http://localhost:4310', projectId: enabled.PRONTO_HUDDLE_PROJECT_ID, environment: 'development', release: 'test-build',
    });
    expect(huddleReviewConfig({ ...enabled, NODE_ENV: 'production', PRONTO_HUDDLE_SERVER_URL: 'https://reviews.example.com/' })?.serverUrl).toBe('https://reviews.example.com');
  });
  it.each(['http://reviews.example.com', 'https://user:secret@example.com', 'https://example.com/path',
    'https://example.com/?secret=1', 'https://example.com/#secret', 'javascript:alert(1)', 'https://example.com/;connect-src *', 'invalid'])('falls back for invalid origin %s', serverUrl => {
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_SERVER_URL: serverUrl })).toBeNull();
  });
  it('requires HTTPS in production and the service schema for project/context', () => {
    expect(huddleReviewConfig({ ...enabled, NODE_ENV: 'production' })).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_PROJECT_ID: 'not-a-project' })).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_ENVIRONMENT: 'Not Accepted' })).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_ENVIRONMENT: 'x'.repeat(41) })).toBeNull();
    expect(huddleReviewConfig({ ...enabled, PRONTO_HUDDLE_RELEASE: 'x'.repeat(121) })).toBeNull();
  });
});
