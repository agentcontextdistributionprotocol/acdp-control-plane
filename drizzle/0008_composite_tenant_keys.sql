-- 0008 — composite (tenant_id, …) primary keys.
--
-- Phase 2.2 of the hardening plan. Tenant columns landed in 0006/0007;
-- this migration folds tenant_id into the primary key of every
-- tenant-scoped entity so the *same logical id* can coexist across
-- tenants (tenant-A's run-42 and tenant-B's run-42 are distinct rows).
--
-- Single-tenant deployments are unaffected: every existing row already
-- carries tenant_id='default', so the new composite key is a superset
-- of the old one and no row collides. The old single-column PKs were
-- created inline (unnamed), so Postgres named them <table>_pkey.

-- runs: run_id → (tenant_id, run_id)
ALTER TABLE runs DROP CONSTRAINT runs_pkey;
ALTER TABLE runs ADD PRIMARY KEY (tenant_id, run_id);

-- agents: agent_did → (tenant_id, agent_did)
ALTER TABLE agents DROP CONSTRAINT agents_pkey;
ALTER TABLE agents ADD PRIMARY KEY (tenant_id, agent_did);

-- registries: authority → (tenant_id, authority)
ALTER TABLE registries DROP CONSTRAINT registries_pkey;
ALTER TABLE registries ADD PRIMARY KEY (tenant_id, authority);

-- lineage_edges: (from_ctx_id, to_ctx_id) → (tenant_id, from_ctx_id, to_ctx_id)
ALTER TABLE lineage_edges DROP CONSTRAINT lineage_edges_pkey;
ALTER TABLE lineage_edges ADD PRIMARY KEY (tenant_id, from_ctx_id, to_ctx_id);

-- agent_capabilities: (agent_did, capability_uri) → (tenant_id, agent_did, capability_uri)
ALTER TABLE agent_capabilities DROP CONSTRAINT agent_capabilities_pkey;
ALTER TABLE agent_capabilities ADD PRIMARY KEY (tenant_id, agent_did, capability_uri);
