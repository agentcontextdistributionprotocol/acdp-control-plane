import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListEventsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by run_id' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional({ description: 'Filter by event type' })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({ description: 'Filter by agent_id' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Filter by registry_authority' })
  @IsOptional()
  @IsString()
  registryAuthority?: string;

  @ApiPropertyOptional({ description: 'ISO-8601: return events with event_ts strictly greater' })
  @IsOptional()
  @IsISO8601()
  afterTs?: string;

  @ApiPropertyOptional({ description: 'ISO-8601: return events with event_ts strictly less' })
  @IsOptional()
  @IsISO8601()
  beforeTs?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 200 })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null ? undefined : Number(value),
  )
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
