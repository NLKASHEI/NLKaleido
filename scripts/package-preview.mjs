import { copyFile, mkdir, stat } from 'node:fs/promises';

await mkdir('.preview-extension-build', { recursive: true });
await copyFile('preview-extension/manifest.json', '.preview-extension-build/manifest.json');
const bundle = await stat('.preview-extension-build/index.js');
if (bundle.size === 0) throw new Error('Preview extension bundle is empty');
console.log('ST preview extension ready:', bundle.size, 'bytes of JavaScript');
