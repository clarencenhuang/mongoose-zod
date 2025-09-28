/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['./test/setup.cjs'],
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: './tsconfig.jest.json',
        diagnostics: {
          ignoreCodes: [1343],
        },
        astTransformers: {
          before: [
            {
              path: 'ts-jest-mock-import-meta',
            },
          ],
        },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!ts-jest-mock-import-meta)'],
  verbose: false,
};
