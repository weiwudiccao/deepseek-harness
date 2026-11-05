/** Run the shared packaged-runtime acceptance harness in its managed-browser scenario. */
process.argv.push('--browser');
await import('./check-office-runtime.mjs');
