/**
 * Integration tests: require a running Postgres with the migration applied.
 * Run with: pnpm --filter @exam-app/api test:integration
 * @type {import('jest').Config}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: 'integration/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 60000,
};
