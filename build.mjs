import { build } from 'esbuild';
import fs from 'node:fs/promises';
await fs.rm('dist', { recursive: true, force: true });
await fs.cp('public', 'dist', { recursive: true });
await fs.copyFile('public/carta.html', 'dist/index.html');
await fs.rm('dist/qr/carta-qr.svg', { force: true });
await build({ entryPoints: ['src/worker.ts'], outfile: 'dist/_worker.js', bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'linked' });
await fs.writeFile('dist/_routes.json', JSON.stringify({version:1,include:['/api/*','/qr/carta-qr.svg','/_worker.js'],exclude:[]}));
console.log('Preparado dist/ para Cloudflare Pages.');
