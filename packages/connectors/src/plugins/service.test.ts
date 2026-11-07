import { describe, expect, it } from 'vitest';
import { ServiceConnector } from './service.ts';

describe('ServiceConnector', () => {
  it('is connected at once, as a service, and sends nothing', () => {
    const c = new ServiceConnector('api:owner', 'api');
    expect(c.account).toBe('api:owner');
    expect(c.status()).toMatchObject({ state: 'connected', phase: 'service' });
    expect(c.send()).toBe(false);
  });
});
