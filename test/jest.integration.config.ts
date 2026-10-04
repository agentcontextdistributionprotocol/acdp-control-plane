import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '\\.integration\\.spec\\.ts$',
  // Nest 12 ships ESM-only; Jest's CommonJS runtime cannot require() it
  // without Node's experimental vm API (#191). @swc/jest down-compiles
  // node_modules/@nestjs/** to CJS inside Jest only -- production still loads
  // it through Node's native require(esm). Keep this entry FIRST (Jest uses the
  // first matching key) and in sync with the `jest` block in package.json;
  // see docs/TESTING.md "Why Jest transforms @nestjs/*".
  transform: {
    '/node_modules/@nestjs/.+\\.js$': [
      '@swc/jest',
      {
        swcrc: false,
        sourceMaps: 'inline',
        jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' },
        module: { type: 'commonjs', importInterop: 'node' },
      },
    ],
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: 'test/tsconfig.test.json' },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/)'],
  testEnvironment: 'node',
  testTimeout: 60000,
  maxWorkers: 1,
  detectOpenHandles: true,
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/setup/global-teardown.ts',
};

export default config;
