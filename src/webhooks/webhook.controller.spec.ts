import { toPublicWebhook } from './webhook.controller';

describe('toPublicWebhook (#230)', () => {
  it('drops the secret and keeps every other field', () => {
    const row = { id: 'w', url: 'https://x.example/h', secret: 's3cret', events: ['a'], active: true };
    const out = toPublicWebhook(row);
    expect(out).not.toHaveProperty('secret');
    expect(out).toEqual({ id: 'w', url: 'https://x.example/h', events: ['a'], active: true });
    expect(row.secret).toBe('s3cret'); // input not mutated (delivery still needs it)
  });
});
