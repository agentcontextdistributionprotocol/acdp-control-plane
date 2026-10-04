import { applyEnvFile } from './env-file';

// Must stay `main.ts`'s FIRST import: it populates process.env from ./.env
// before anything (AppConfigService included) reads it. See
// docs/CONFIGURATION.md and src/load-env.spec.ts.
applyEnvFile(process.env);
