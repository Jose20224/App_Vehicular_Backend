/* eslint-disable no-console */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = process.env.OPENAPI_URL;
if (!source) throw new Error('Set OPENAPI_URL to the running Nest Swagger JSON endpoint (for example http://localhost:3000/docs-json).');
const output = path.resolve(process.env.OPENAPI_TYPES_OUTPUT || 'src/api/openapi.generated.ts');
const cli = path.resolve('node_modules/openapi-typescript/bin/cli.js');
execFileSync(process.execPath, [cli, source, '--output', output], { stdio: 'inherit' });
