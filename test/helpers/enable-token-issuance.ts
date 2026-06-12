/**
 * Side-effect module: flip on token issuance BEFORE `AppModule` is imported.
 *
 * `AuthModule.forRoot()` reads `TOKEN_ISSUANCE_ENABLED` at module-evaluation
 * time (the `@Module({ imports: [AuthModule.forRoot()] })` decorator runs when
 * app.module.ts is first imported). ES `import` statements are hoisted and run
 * depth-first in source order, so a spec that needs the issuance routes mounted
 * must import THIS module first — its body sets the env var before the later
 * `test-app` import pulls in (and evaluates) AppModule.
 *
 * Integration specs share one process (`--runInBand`) and each test file gets a
 * fresh module registry, so a later spec re-evaluates AppModule and re-reads
 * this flag. The issuance spec therefore deletes it in `afterAll` (see
 * auth-issuance.integration.spec.ts) so the flag never leaks into siblings.
 */
process.env.TOKEN_ISSUANCE_ENABLED = 'true';
