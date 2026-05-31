import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

export class EnrollRegistryDto {
  @ApiProperty({ description: 'ACDP authority, e.g. registry-a.example' })
  @IsString()
  @MinLength(1)
  authority!: string;

  @ApiPropertyOptional({
    description: 'Tenant this authority belongs to. Defaults to "default".',
  })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Registry public base URL for the federation proxy.' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Registry DID (did:web:...).' })
  @IsOptional()
  @IsString()
  registryDid?: string;

  @ApiPropertyOptional({
    description:
      'Per-registry HMAC secret for ingest. Minimum 16 chars. Omit to use the global WEBHOOK_SECRET.',
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  webhookSecret?: string;

  @ApiPropertyOptional({ description: 'Whether ingest from this authority is accepted.', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
