/**
 * Capability endpoints — mounted at `/capabilities` so they don't
 * collide with the existing `GET /agents/*did` wildcard.
 *
 *   POST   /capabilities                  declare (auth-gated)
 *   GET    /capabilities/search?capability=urn:acdp:cap:...
 *   GET    /capabilities/by-agent/*did    list one agent's caps
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsISO8601, IsIn, IsString, MinLength } from 'class-validator';
import { CheckPolicy } from '../policy/check-policy.decorator';
import { CheckQuota } from '../quota/check-quota.decorator';
import { tenantOf, TenantedRequest } from '../tenant/request-tenant';
import { CapabilityService } from './capability.service';

const ALG_OPTIONS = ['ed25519'] as const;

export class DeclareCapabilityRequestDto {
  @ApiProperty({ description: 'Agent DID making the declaration.', example: 'did:web:cp.example.com:agents:alice' })
  @IsString()
  @MinLength(1)
  agent_did!: string;

  @ApiProperty({
    description: 'Capability URI. Form: `urn:acdp:cap:<verb>:<type>:<domain>`.',
    example: 'urn:acdp:cap:publish:data_snapshot:finance',
  })
  @IsString()
  @MinLength(1)
  capability_uri!: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp the agent used when computing the signature. Must be within ±300s of now.',
    example: '2026-05-25T18:00:00Z',
  })
  @IsISO8601()
  declared_at!: string;

  @ApiProperty({ description: 'Verification method id (key_id from the agent\'s DID document).' })
  @IsString()
  @MinLength(1)
  key_id!: string;

  @ApiProperty({ description: 'Signature algorithm.', enum: ALG_OPTIONS })
  @IsString()
  @IsIn(ALG_OPTIONS as unknown as string[])
  algorithm!: string;

  @ApiProperty({
    description: 'Base64-encoded Ed25519 signature over `acdp-cap:v1:<agent_did>:<capability_uri>:<declared_at>`.',
  })
  @IsString()
  @MinLength(1)
  signature!: string;
}

export class CapabilityResponseDto {
  @ApiProperty()
  agent_did!: string;
  @ApiProperty()
  capability_uri!: string;
  @ApiProperty()
  declared_at!: string;
  @ApiProperty()
  signed_by!: string;
}

@ApiTags('agents')
@Controller('capabilities')
export class CapabilityController {
  constructor(private readonly service: CapabilityService) {}

  @Post()
  @CheckPolicy('capability.declare')
  @CheckQuota('capability.declare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Self-declare a capability for an agent (Ed25519-signed).',
    description:
      'The signature MUST cover `acdp-cap:v1:<agent_did>:<capability_uri>:<declared_at>` and verify ' +
      'against the agent\'s pinned public key. Idempotent: redeclaring the same `(agent_did, capability_uri)` ' +
      'returns the original record.',
  })
  @ApiBody({ type: DeclareCapabilityRequestDto })
  @ApiOkResponse({ type: CapabilityResponseDto })
  @ApiBadRequestResponse({ description: 'Bad URN, unsupported algorithm, or out-of-window declared_at.' })
  @ApiUnauthorizedResponse({ description: 'Signature does not verify, or agent has no pinned key.' })
  async declare(
    @Body() body: DeclareCapabilityRequestDto,
    @Req() req: TenantedRequest,
  ): Promise<CapabilityResponseDto> {
    const row = await this.service.declare(
      {
        agentDid: body.agent_did,
        capabilityUri: body.capability_uri,
        declaredAtIso: body.declared_at,
        keyId: body.key_id,
        algorithm: body.algorithm,
        signature: body.signature,
      },
      tenantOf(req),
    );
    return rowToDto(row);
  }

  @Get('search')
  @ApiOperation({ summary: 'Find agents that have declared a capability.' })
  @ApiOkResponse({ type: CapabilityResponseDto, isArray: true })
  async search(
    @Req() req: TenantedRequest,
    @Query('capability') capability?: string,
  ) {
    if (!capability) {
      throw new BadRequestException('`capability` query parameter is required');
    }
    const rows = await this.service.findAgentsWithCapability(capability, tenantOf(req));
    return { data: rows.map(rowToDto), total: rows.length };
  }

  @Get('by-agent/*did')
  @ApiOperation({ summary: 'List one agent\'s declared capabilities.' })
  @ApiOkResponse({ type: CapabilityResponseDto, isArray: true })
  async byAgent(
    @Param('did') didParts: string[] | string,
    @Req() req: TenantedRequest,
  ) {
    const did = Array.isArray(didParts) ? didParts.join('/') : didParts;
    const rows = await this.service.listForAgent(did, tenantOf(req));
    return { data: rows.map(rowToDto), total: rows.length };
  }
}

function rowToDto(r: {
  agentDid: string;
  capabilityUri: string;
  declaredAt: string;
  signedBy: string;
}): CapabilityResponseDto {
  return {
    agent_did: r.agentDid,
    capability_uri: r.capabilityUri,
    declared_at: r.declaredAt,
    signed_by: r.signedBy,
  };
}
