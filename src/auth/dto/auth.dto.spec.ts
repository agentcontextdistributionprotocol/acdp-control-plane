import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IntrospectRequestDto } from '../introspect.controller';
import { RevokeRequestDto } from '../revoke.controller';
import {
  AUTH_ALGORITHM_MAX_LENGTH,
  AUTH_FIELD_MAX_LENGTH,
  BEARER_TOKEN_MAX_LENGTH,
  ChallengeRequestDto,
  TokenRequestDto,
} from './auth.dto';

const validToken = {
  agent_id: 'did:web:cp.test:agents:a',
  key_id: 'key-1',
  nonce: 'n'.repeat(16),
  expires_at: 1716661234,
  algorithm: 'ed25519',
  signature: 'AAAA',
};

async function errorsFor<T extends object>(cls: new () => T, body: object): Promise<string[]> {
  const errs = await validate(plainToInstance(cls, body));
  return errs.map((e) => e.property);
}

describe('auth DTO length bounds (#225)', () => {
  it.each(['agent_id', 'key_id', 'nonce', 'signature'] as const)(
    'TokenRequestDto.%s: %i chars passes, one more fails',
    async (field) => {
      const at = { ...validToken, [field]: 'x'.repeat(AUTH_FIELD_MAX_LENGTH) };
      expect(await errorsFor(TokenRequestDto, at)).toEqual([]);
      const over = { ...validToken, [field]: 'x'.repeat(AUTH_FIELD_MAX_LENGTH + 1) };
      expect(await errorsFor(TokenRequestDto, over)).toEqual([field]);
    },
  );

  it('TokenRequestDto.algorithm is capped', async () => {
    const at = { ...validToken, algorithm: 'a'.repeat(AUTH_ALGORITHM_MAX_LENGTH) };
    expect(await errorsFor(TokenRequestDto, at)).toEqual([]);
    const over = { ...validToken, algorithm: 'a'.repeat(AUTH_ALGORITHM_MAX_LENGTH + 1) };
    expect(await errorsFor(TokenRequestDto, over)).toEqual(['algorithm']);
  });

  it('ChallengeRequestDto.agent_id is capped', async () => {
    expect(
      await errorsFor(ChallengeRequestDto, { agent_id: 'x'.repeat(AUTH_FIELD_MAX_LENGTH) }),
    ).toEqual([]);
    expect(
      await errorsFor(ChallengeRequestDto, { agent_id: 'x'.repeat(AUTH_FIELD_MAX_LENGTH + 1) }),
    ).toEqual(['agent_id']);
  });

  it.each([
    ['RevokeRequestDto', RevokeRequestDto],
    ['IntrospectRequestDto', IntrospectRequestDto],
  ] as const)('%s.token is capped at the bearer-token bound', async (_n, cls) => {
    expect(await errorsFor(cls, { token: 't'.repeat(BEARER_TOKEN_MAX_LENGTH) })).toEqual([]);
    expect(await errorsFor(cls, { token: 't'.repeat(BEARER_TOKEN_MAX_LENGTH + 1) })).toEqual([
      'token',
    ]);
  });
});
