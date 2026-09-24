/**
 * Registry capabilities probe for the trust sweeps (receipt audit +
 * transparency-log witness).
 *
 * Fetches a registry's `/.well-known/acdp.json` (RFC-ACDP-0007) through the
 * same SSRF-gated federation client the context proxy uses, and answers the
 * questions the auditors need:
 *
 *   - does this registry advertise `acdp-registry-receipts`? (a registry
 *     that does MUST mint a receipt on every publish — absence is a
 *     discrepancy);
 *   - does it advertise `acdp-registry-transparency-log` (RFC-ACDP-0012
 *     §11)? (a registry that does MUST log every accepted publish and serve
 *     all three /log endpoints — the checkpoint witness enrolls it).
 *
 * The advertised profile list is cached in-memory per (tenant, authority)
 * for `cacheTtlMs` (default 10 minutes): the sweeps may probe the same
 * registry hundreds of times per pass, and capabilities churn slowly.
 *
 * RFC-ACDP-0014 §6's registry-binding check (`src/audit/revocation-binding.ts`)
 * needs two more fields off the SAME document: `registry_did` and
 * `acdp_version` are unconditionally present, top-level members of the
 * `/.well-known/acdp.json` capabilities document (`acdp-types::CapabilitiesDocument`,
 * not nested under a `capabilities` key) — so the existing probe captures
 * them too, at no extra HTTP cost, rather than adding a second fetch.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SafeFederationClient } from '../contexts/safe-federation-client';
import { RegistryRepository } from '../storage/registry.repository';

export const RECEIPTS_PROFILE = 'acdp-registry-receipts';
/** RFC-ACDP-0012 §11 — the name reserved by RFC-ACDP-0009 §2.11. */
export const TRANSPARENCY_LOG_PROFILE = 'acdp-registry-transparency-log';

/** The RFC-ACDP-0014 §6 registry-binding fields, tri-stated together (see {@link RegistryProfileService.registryCapabilities}). */
export interface RegistryCapabilitiesInfo {
  /** The advertised `registry_did`; null when the document was unreadable. */
  registryDid: string | null;
  /** The advertised `acdp_version`; null when the document was unreadable. NOT parsed/compared in this phase — captured for observability only. */
  acdpVersion: string | null;
}

interface ProfileCacheEntry {
  /** Advertised profiles; null when the document was unreadable. */
  profiles: string[] | null;
  /** The advertised `registry_did`; null when the document was unreadable. */
  registryDid: string | null;
  /** The advertised `acdp_version`; null when the document was unreadable. */
  acdpVersion: string | null;
  cachedAt: number;
}

@Injectable()
export class RegistryProfileService {
  private readonly logger = new Logger(RegistryProfileService.name);
  private readonly cache = new Map<string, ProfileCacheEntry>();
  private readonly cacheTtlMs = 10 * 60 * 1000;

  constructor(
    private readonly registryRepo: RegistryRepository,
    private readonly federationClient: SafeFederationClient,
  ) {}

  /**
   * True / false when the registry's capabilities document was readable;
   * null when the registry is unknown, unreachable, or served an
   * unparseable document (the auditors then treat absence as informational
   * rather than a discrepancy — never flag on a guess).
   */
  async advertisesReceipts(authority: string, tenantId: string): Promise<boolean | null> {
    return this.advertisesProfile(authority, tenantId, RECEIPTS_PROFILE);
  }

  /** Same tri-state contract for the RFC-ACDP-0012 transparency-log profile. */
  async advertisesTransparencyLog(
    authority: string,
    tenantId: string,
  ): Promise<boolean | null> {
    return this.advertisesProfile(authority, tenantId, TRANSPARENCY_LOG_PROFILE);
  }

  async advertisesProfile(
    authority: string,
    tenantId: string,
    profile: string,
  ): Promise<boolean | null> {
    const profiles = await this.profilesFor(authority, tenantId);
    return profiles === null ? null : profiles.includes(profile);
  }

  /**
   * RFC-ACDP-0014 §6: the advertised `registry_did` and `acdp_version`, tri-
   * stated TOGETHER off the same cached probe as `advertisesReceipts` /
   * `advertisesTransparencyLog` — both null when the document was unreadable
   * (registry unknown, unreachable, or unparseable), never a guess. No
   * additional HTTP request beyond the existing profiles probe.
   */
  async registryCapabilities(authority: string, tenantId: string): Promise<RegistryCapabilitiesInfo> {
    const entry = await this.entryFor(authority, tenantId);
    return { registryDid: entry.registryDid, acdpVersion: entry.acdpVersion };
  }

  /** Visible for tests. */
  cacheSize(): number {
    return this.cache.size;
  }

  private async profilesFor(authority: string, tenantId: string): Promise<string[] | null> {
    return (await this.entryFor(authority, tenantId)).profiles;
  }

  private async entryFor(authority: string, tenantId: string): Promise<ProfileCacheEntry> {
    const cacheKey = `${tenantId} ${authority}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached;
    }

    const entry = { ...(await this.probe(authority, tenantId)), cachedAt: Date.now() };
    this.cache.set(cacheKey, entry);
    return entry;
  }

  private async probe(
    authority: string,
    tenantId: string,
  ): Promise<Omit<ProfileCacheEntry, 'cachedAt'>> {
    const unreadable = { profiles: null, registryDid: null, acdpVersion: null };
    const registry = await this.registryRepo.findByAuthority(authority, tenantId);
    if (!registry?.baseUrl) return unreadable;

    const url = `${registry.baseUrl.replace(/\/$/, '')}/.well-known/acdp.json`;
    try {
      const resp = await this.federationClient.get(url);
      if (resp.status < 200 || resp.status >= 300) return unreadable;
      const doc = JSON.parse(resp.body) as {
        profiles?: unknown;
        registry_did?: unknown;
        acdp_version?: unknown;
      };
      const profiles = Array.isArray(doc.profiles)
        ? doc.profiles.filter((p): p is string => typeof p === 'string')
        : [];
      return {
        profiles,
        registryDid: typeof doc.registry_did === 'string' ? doc.registry_did : null,
        acdpVersion: typeof doc.acdp_version === 'string' ? doc.acdp_version : null,
      };
    } catch (err) {
      this.logger.debug(
        `capabilities probe for '${authority}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return unreadable;
    }
  }
}
