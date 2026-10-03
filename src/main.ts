import 'dotenv/config';
// The .env preload above MUST stay the first import: it populates process.env
// before anything (AppConfigService included) reads it. See
// docs/CONFIGURATION.md and src/dotenv-preload.spec.ts.
import { bootstrap, reportBootstrapFailure } from './bootstrap';

bootstrap().catch(reportBootstrapFailure);
