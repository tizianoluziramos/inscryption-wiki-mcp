import { initialize } from '../src/initialize.js';

function flags(argv) {
  const allowed = new Set(['--html', '--history', '--no-relations', '--no-files', '--no-categories', '--main-only']);
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new Error(`Unknown flag: ${arg}`);
  }
  return {
    includeHtml: argv.includes('--html'),
    includeHistory: argv.includes('--history'),
    includeRelations: !argv.includes('--no-relations'),
    includeFiles: !argv.includes('--no-files'),
    includeCategories: !argv.includes('--no-categories'),
    namespace: argv.includes('--main-only') ? 0 : null,
  };
}

try {
  const options = flags(process.argv.slice(2));
  const { exporter } = initialize();
  for (;;) {
    const result = await exporter.batch({ ...options, maxItems: 50 });
    console.error(JSON.stringify(result));
    if (result.complete) break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
