/**
 * Plain JS config on purpose: a jest.config.ts requires `ts-node` to be installed,
 * which this package does not (and need not) depend on. ts-jest handles the sources.
 * @type {import('jest').Config}
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/integration/'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
};
