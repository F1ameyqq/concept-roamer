import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'tests/**', 'scripts/**', 'build.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ['eslint.config.mjs'] } } },
    // Chinese UI includes proper brand names such as DeepSeek; English sentence case is not applicable.
    rules: { 'obsidianmd/ui/sentence-case': 'off' },
  },
]);
