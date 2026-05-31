/**
 * Capability declaration + discovery.
 *
 * Self-declaration flow (per deferred-plan §4):
 *   1. Agent generates `declared_at = now-ish` and computes
 *      `acdp-cap:v1:<agent_did>:<capability_uri>:<declared_at>`.
 *   2. Agent Ed25519-signs that canonical string with their pinned key.
 *   3. POST to /agents/capabilities with the signature + key_id.
 *   4. Server verifies the signature against the pinned public key,
 *      pins `declared_at` server-side (rejecting any future-dated
 *      drift), and persists.
 *
 * Discovery: orchestrators query by capability_uri (`GET /agents?
 * capability=...`). V2 layers RL bandit routing (#5) on top.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { verifyEcdsaP256 } from '../auth/ecdsa-p256';
import { verifyEd25519 } from '../auth/ed25519';
import { PinnedKeysService } from '../auth/pinned-keys.service';
import { DEFAULT_TENANT_ID } from '../tenant/tenant-context';
import { capabilityAssertion, parseCapabilityUri } from './capability-uri';
import { CapabilityRepository, CapabilityRow } from './capability.repository';

const MAX_CLOCK_SKEW_SECONDS = 300;

@Injectable()
export class CapabilityService {
  private readonly logger = new Logger(CapabilityService.name);

  constructor(
    private readonly repo: CapabilityRepository,
    private readonly pinned: PinnedKeysService,
  ) {}

  /**
   * Visible for tests — load pinned keys from an explicit string.
   * Delegates to the shared `PinnedKeysService` (loaded globally
   * by `AppModule`); tests use this to bypass env-driven init.
   */
  setPinnedKeys(raw: string): void {
    this.pinned.load(raw);
  }

  /**
   * Verify + persist one capability declaration.
   *
   * `declaredAtIso` is the value the agent USED when computing the
   * signature; the server validates it's within ±300s of `now` and
   * stores that same value (so a re-fetch returns what the agent
   * signed).
   */
  async declare(
    req: {
      agentDid: string;
      capabilityUri: string;
      declaredAtIso: string;
      keyId: string;
      algorithm: string;
      signature: string;
    },
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<CapabilityRow> {
    // Schema validation (URN form + segment char set).
    parseCapabilityUri(req.capabilityUri);

    if (req.algorithm !== 'ed25519' && req.algorithm !== 'ecdsa-p256') {
      throw new BadRequestException(
        `unsupported signature algorithm: '${req.algorithm}' (supported: ed25519, ecdsa-p256)`,
      );
    }

    // Clock-skew check on the agent-provided timestamp.
    const declaredAtMs = Date.parse(req.declaredAtIso);
    if (!Number.isFinite(declaredAtMs)) {
      throw new BadRequestException(
        `declared_at is not a valid ISO-8601 timestamp: '${req.declaredAtIso}'`,
      );
    }
    const skewSec = Math.abs(Date.now() - declaredAtMs) / 1000;
    if (skewSec > MAX_CLOCK_SKEW_SECONDS) {
      throw new BadRequestException(
        `declared_at clock skew ${skewSec.toFixed(0)}s exceeds ${MAX_CLOCK_SKEW_SECONDS}s window`,
      );
    }

    // Resolve pinned key. V2 plugs in did:web (#1) as a fallback here.
    const pinned = this.pinned.get(req.agentDid);
    if (!pinned) {
      throw new UnauthorizedException(
        `agent_did '${req.agentDid}' has no pinned public key on this control plane`,
      );
    }

    // Algorithm-downgrade defense: request algorithm must match pinned.
    if (req.algorithm !== pinned.algorithm) {
      throw new UnauthorizedException(
        `signature.algorithm '${req.algorithm}' does not match pinned algorithm ` +
          `'${pinned.algorithm}' for ${req.agentDid}`,
      );
    }

    const signingInput = capabilityAssertion(
      req.agentDid,
      req.capabilityUri,
      req.declaredAtIso,
    );
    const ok =
      pinned.algorithm === 'ed25519'
        ? verifyEd25519(pinned.publicKey, signingInput, req.signature)
        : verifyEcdsaP256(pinned.publicKey, signingInput, req.signature);
    if (!ok) {
      throw new UnauthorizedException('capability declaration signature verification failed');
    }

    const row = await this.repo.declare({
      agentDid: req.agentDid,
      capabilityUri: req.capabilityUri,
      declaredAt: req.declaredAtIso,
      signedBy: req.keyId,
      signature: req.signature,
      tenantId,
    });

    this.logger.log(
      `capability declared: agent=${req.agentDid} cap=${req.capabilityUri} key=${req.keyId}`,
    );
    return row;
  }

  /** List an agent's declared capabilities. */
  async listForAgent(
    agentDid: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<CapabilityRow[]> {
    return this.repo.findByAgent(agentDid, tenantId);
  }

  /** Find agents that declared a capability. */
  async findAgentsWithCapability(
    capabilityUri: string,
    tenantId: string = DEFAULT_TENANT_ID,
  ): Promise<CapabilityRow[]> {
    // Validate the query shape so a typo returns 400 instead of [].
    parseCapabilityUri(capabilityUri);
    return this.repo.findByCapability(capabilityUri, tenantId);
  }
}
