import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['dist/**','node_modules/**','specs/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.ts', '**/*.mjs'], languageOptions: { globals: {
    process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly',
    AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly',
  } } },
);
