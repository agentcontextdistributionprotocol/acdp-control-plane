import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Payload the playground POSTs to `/runs/started` when a run begins. Carries
 * the `scenario_id` that the webhook ingest path can't know (registry events
 * don't include it), so the run is correctly attributed in the dashboard
 * instead of falling back to `'unknown'`.
 *
 * Field names are snake_case to match the playground's wire format.
 */
export class RunStartedDto {
  @ApiProperty({ description: 'Unique run identifier (UUID).' })
  @IsString()
  @IsNotEmpty()
  run_id!: string;

  @ApiProperty({ description: 'Scenario identifier this run is executing.' })
  @IsString()
  @IsNotEmpty()
  scenario_id!: string;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp when the run started.' })
  @IsOptional()
  @IsString()
  started_at?: string;

  @ApiPropertyOptional({ description: 'Scenario inputs the run was launched with.' })
  @IsOptional()
  @IsObject()
  inputs?: Record<string, unknown>;
}
