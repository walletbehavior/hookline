import {build} from '../wallet-client/node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await build({absWorkingDir:root,entryPoints:['wallet-client/entry.jsx'],outfile:'dist/privy-wallet.js',
  bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',
  define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
