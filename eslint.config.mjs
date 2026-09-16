import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**'] },
  js.configs.recommended,
  {
    files: ['**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  { files: ['src/*.js'], languageOptions: { globals: globals.browser } },
];
