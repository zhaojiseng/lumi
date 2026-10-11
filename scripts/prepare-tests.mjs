import {mkdir} from 'node:fs/promises';
await mkdir('.test-data',{recursive:true});
// The GUI-owned gateway tests use the bundled fixed helper, including a fresh checkout.
await import('./build-gateway-runtime.mjs');
