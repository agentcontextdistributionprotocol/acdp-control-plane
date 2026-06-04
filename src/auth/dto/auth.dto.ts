import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MinLength, Min } from 'class-validator';

export class ChallengeRequestDto {
  @ApiProperty({
    description:
      'Agent DID requesting the challenge. Typically `did:web:<authority>:agents:<id>`.',
    example: 'did:web:cp.example.com:agents:alice',
  })
  @IsString()
  @MinLength(1)
  agent_id!: string;
}

export class ChallengeResponseDto {
  @ApiProperty({
    description: 'Server-generated nonce. Single-use. Embed verbatim in `signing_input`.',
    example: 'b7e8d3a1c5f9...',
  })
  nonce!: string;

  @ApiProperty({
    description:
      'Authority of the issuer this challenge is bound to. Must match the registry/control-plane the token will be presented to.',
    example: 'cp.example.com',
  })
  registry_authority!: string;

  @ApiProperty({
    description: 'Unix seconds at which this challenge expires. Sign within the window.',
    example: 1716661234,
  })
  expires_at!: number;

  @ApiProperty({
    description:
      'Canonical string the agent must sign with its Ed25519 / ECDSA-P256 key. ' +
      'Format: `acdp-registry-auth:v1:<nonce>:<agent_did>:<registry_authority>:<expires_at>`.',
    example: 'acdp-registry-auth:v1:b7e8...:did:web:cp.example.com:agents:alice:cp.example.com:1716661234',
  })
  signing_input!: string;
}

export class TokenRequestDto {
  @ApiProperty({
    description: 'Agent DID — must equal the `agent_id` from the challenge.',
    example: 'did:web:cp.example.com:agents:alice',
  })
  @IsString()
  @MinLength(1)
  agent_id!: string;

  @ApiProperty({
    description: 'Identifier of the verification method (key) used to produce the signature.',
    example: 'key-1',
  })
  @IsString()
  @MinLength(1)
  key_id!: string;

  @ApiProperty({
    description: 'Nonce returned by `POST /auth/challenge`. Single-use.',
    example: 'b7e8d3a1c5f9...',
  })
  @IsString()
  @MinLength(1)
  nonce!: string;

  @ApiProperty({
    description: 'Unix seconds — must equal the `expires_at` from the challenge response.',
    example: 1716661234,
  })
  @IsInt()
  @Min(0)
  expires_at!: number;

  @ApiProperty({
    description:
      'Signature algorithm over `signing_input`. Both `ed25519` and ' +
      '`ecdsa-p256` (IEEE-1363, not DER) are accepted; must match the ' +
      'pinned/resolved key for the agent (downgrade defense).',
    example: 'ed25519',
    enum: ['ed25519', 'ecdsa-p256'],
  })
  @IsString()
  algorithm!: string;

  @ApiProperty({
    description: 'Base64-encoded signature over `signing_input` from the challenge response.',
    example: '7p9KZ...==',
  })
  @IsString()
  @MinLength(1)
  signature!: string;
}

export class TokenResponseDto {
  @ApiProperty({
    description: 'Bearer JWT. Present as `Authorization: Bearer <token>`.',
    example: 'eyJhbGciOi...',
  })
  token!: string;

  @ApiProperty({
    description: 'Token type. Always `Bearer`.',
    example: 'Bearer',
  })
  token_type!: string;

  @ApiProperty({
    description: 'Unix seconds at which the token expires.',
    example: 1716665000,
  })
  expires_at!: number;
}

export class AuthErrorDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({ example: 'unsupported algorithm: ecdsa-p256' })
  message!: string;
}
