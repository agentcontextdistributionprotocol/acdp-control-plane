import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * A tenant id some key or claim can actually resolve to (#246): non-empty, no
 * leading/trailing whitespace (TENANT_API_KEYS bindings are trimmed, so a
 * padded id is unreachable) and no control characters. Deliberately NOT a
 * charset — a JWT `tenant` claim can already carry e.g. `Acme Corp`, and the
 * registry defines none either.
 */
const REACHABLE_TENANT_ID = /^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u;

export class EnrollRegistryDto {
  @ApiProperty({ description: 'ACDP authority, e.g. registry-a.example' })
  @IsString()
  @MinLength(1)
  authority!: string;

  @ApiPropertyOptional({
    description:
      "Tenant this authority belongs to. Defaults to the caller's tenant (the admin " +
      'key\'s bound tenant; an unbound key resolves to the untenanted bucket). The ' +
      'reserved `default` tenant cannot be named explicitly. Immutable once enrolled: ' +
      're-enrolling under a different tenant is rejected with 409 REGISTRY_ENROLLED_ELSEWHERE. ' +
      'Must be non-empty with no leading/trailing whitespace or control characters (400 otherwise).',
  })
  @IsOptional()
  @IsString()
  @Matches(REACHABLE_TENANT_ID, {
    message:
      'tenantId must be non-empty, with no leading/trailing whitespace or control characters',
  })
  tenantId?: string;

  // Re-enroll is PATCH-like (tenant-enroll-quota-fix P2): for the nullable
  // fields below, OMITTING a field keeps the stored value and an explicit
  // `null` clears it. `@IsOptional()` skips validation for both `null` and
  // `undefined`, and the ValidationPipe preserves the distinction (pinned by
  // `enroll-registry.dto.spec.ts`).

  @ApiPropertyOptional({
    description:
      'Registry public base URL for the federation proxy. On re-enroll: omit to keep the ' +
      'stored value, `null` to clear it.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string | null;

  @ApiPropertyOptional({
    description:
      'Registry DID (did:web:...). On re-enroll: omit to keep the stored value, `null` to clear it.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsString()
  registryDid?: string | null;

  @ApiPropertyOptional({
    description:
      'Per-registry HMAC secret for ingest. Minimum 16 chars. Never echoed back. When unset, ' +
      'ingest uses the global WEBHOOK_SECRET. On re-enroll: omit to keep the stored secret, ' +
      '`null` to clear it (ingest then falls back to the global WEBHOOK_SECRET).',
    nullable: true,
    type: String,
    minLength: 16,
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  webhookSecret?: string | null;

  @ApiPropertyOptional({
    description:
      'Whether ingest from this authority is accepted. Defaults to true on first enroll; on ' +
      're-enroll, omit (or send `null`) to keep the stored value — a re-enroll never ' +
      're-enables a disabled registry unless `enabled: true` is sent.',
    default: true,
    nullable: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;
}
