import { initialize } from '../src/initialize.js';

try {
  const { media } = initialize();
  for (;;) {
    const result = await media.batch({ maxItems: 20 });
    console.error(JSON.stringify(result));
    if (result.completed) break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
