import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

const PARENT_IMPORTS = {
  group: ['../*', '../**'],
  message:
    "Use the package's #src/* alias, or another package's name, for cross-directory imports. Keep ./foo for same-directory imports.",
};

/** Production code never depends on test code, so it can be shipped without it. */
const TEST_IMPORTS = {
  regex: '^(#test/|@[\\w-]+/[\\w-]+/test/)',
  message: 'Only tests may import the test helpers.',
};

const TESTS = ['**/*.test.ts', '**/*.test.tsx'];

/** The rule with the given patterns, `../` always among them. */
const restrict = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns: [PARENT_IMPORTS, ...patterns] }],
});

export default tseslint.config(
  // Coverage reports and the web UI's build, git-ignored: the flat config does not read
  // .gitignore.
  { ignores: ['coverage/', '**/dist/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: {
      import: importPlugin,
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      // Only dead imports are removed automatically; other unused code is left to review.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      'import/consistent-type-specifier-style': ['error', 'prefer-inline'],
      'import/no-duplicates': ['error', { 'prefer-inline': true }],
      'unused-imports/no-unused-imports': 'error',
      ...restrict(),
      // One group, so autofix never inserts blank lines between categories: packages, then
      // the #src and #test aliases, then relative imports, then side-effect imports.
      'simple-import-sort/imports': [
        'error',
        { groups: [['^@?\\w', '^#src(?:/.*|$)', '^#test(?:/.*|$)', '^\\.', '^\\u0000']] },
      ],
      'simple-import-sort/exports': 'error',
    },
  },
  // Production code (the entry point, each package's sources and tools): no test helpers.
  {
    files: ['src/**/*.ts', 'packages/*/src/**/*.{ts,tsx}', 'packages/*/tools/**/*.ts'],
    ignores: TESTS,
    rules: restrict(TEST_IMPORTS),
  },
  {
    // The shell's core knows nothing of any game, nor of the other packages (docs/bot-os-api.md
    // §6): only itself, zod, resvg (the render service) and Node.
    files: ['packages/core/src/**/*.ts'],
    ignores: TESTS,
    rules: restrict(TEST_IMPORTS, {
      regex: '^@megabottron1999/',
      message: 'The core imports only itself.',
    }),
  },
  {
    // The web UI's app (docs/bot-os.md D43) imports the core's types only, in `import type`
    // statements, which the bundler always drops: an inline `type` specifier would leave
    // `import {} from …` behind, and pull the core's Node modules into the browser's bundle.
    files: ['packages/web/src/ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import/no-duplicates': ['error', { 'prefer-inline': false }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@megabottron1999/',
              allowTypeImports: true,
              message: 'The app imports only the shell’s types (`import type … from`).',
            },
          ],
        },
      ],
    },
  },
  {
    // The app's tests are not bundled: one may run what the app makes against the shell itself (a
    // script's export, on the dev kit).
    files: ['packages/web/src/ui/**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  }
);
