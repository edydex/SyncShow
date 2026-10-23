// Offline build: reuse the exact browser service core and desktop archive rules.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'web-prepare/dist');
const packageRoot = resolve(root, 'packages/service-core');
const modules = new Map();
const sources = {};
async function collect(file) {
  const id = relative(packageRoot, file).replaceAll('\\', '/');
  if (id.startsWith('../')) throw new Error('Browser build cannot include desktop modules.');
  if (modules.has(id)) return id;
  const source = await readFile(file, 'utf8');
  sources[relative(root, file)] = createHash('sha256').update(source).digest('hex');
  const record = { source: file.endsWith('.json') ? `module.exports = ${source};` : source, dependencies: {} };
  modules.set(id, record);
  if (!file.endsWith('.json')) for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    if (!match[1].startsWith('.')) throw new Error(`Desktop dependency in browser core: ${match[1]}`);
    let dependency = resolve(dirname(file), match[1]);
    if (!dependency.endsWith('.json') && !dependency.endsWith('.js')) dependency += '.js';
    record.dependencies[match[1]] = await collect(dependency);
  }
  return id;
}
const entry = await collect(resolve(packageRoot, 'index.js'));
const runtime = await collect(resolve(packageRoot, 'node/runtime.js'));
const factories = [...modules].map(([id, record]) => `${JSON.stringify(id)}:[function(module,exports,require){\n${record.source}\n},${JSON.stringify(record.dependencies)}]`).join(',\n');
const bundle = `// Generated from SyncShow's browser-safe service core. Do not edit.\n(function(root){'use strict';const modules={${factories}};const cache={};function load(id){if(cache[id])return cache[id].exports;const pair=modules[id];if(!pair)throw Error('Unknown browser core module');const module=cache[id]={exports:{}};pair[0](module,module.exports,name=>load(pair[1][name]));return module.exports;}root.SyncShowCore=load(${JSON.stringify(entry)});root.SyncShowSharedRuntime=load(${JSON.stringify(runtime)});})(globalThis);\n`;

// These helpers are pure. Generate them from the maintained desktop decoder,
// rather than maintaining a second definition of the portable format.
const exchange = await readFile(resolve(root, 'src/services/project/ServiceProjectExchange.js'), 'utf8');
const start = exchange.indexOf("const BUNDLE_KIND =");
const end = exchange.indexOf('class ServiceProjectExchange {');
if (start < 0 || end <= start) throw new Error('Desktop archive boundary changed; review browser adapter.');
const helpers = exchange.slice(start, end);
const executableHelpers = helpers.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
if (/require\(|\b(?:fs|process|JSZip|readFileNoFollow)\b/.test(executableHelpers)) throw new Error('Archive helpers acquired a desktop dependency.');
const imageStore = await readFile(resolve(root, 'src/services/project/ServiceProjectStore.js'), 'utf8');
const magicStart = imageStore.indexOf('function imageFormatFromMagic(');
const magicEnd = imageStore.indexOf('\nfunction videoFormatFromMagic(', magicStart);
const imageLimit = imageStore.match(/const MAX_IMAGE_BYTES = ([\d *]+);/)?.[1];
if (magicStart < 0 || magicEnd < 0 || !imageLimit) throw new Error('Desktop image contract changed; review browser adapter.');
sources['src/services/project/ServiceProjectExchange.js'] = createHash('sha256').update(exchange).digest('hex');
sources['src/services/project/ServiceProjectStore.js'] = createHash('sha256').update(imageStore).digest('hex');
let portable = await readFile(resolve(root, 'web-prepare/portable-runtime.js'), 'utf8');
portable = portable.replace('/* DESKTOP_FORMAT_HELPERS */', `const MAX_IMAGE_BYTES = ${imageLimit};\n${imageStore.slice(magicStart, magicEnd)}\n${helpers}`);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'service-core.js'), bundle);
await writeFile(resolve(output, 'portable.js'), portable);
for (const name of ['index.html', 'style.css', 'app.js', 'editor-model.js', 'recovery.js', 'workspace-controls.js', 'workspace-recovery.js', '_headers']) await copyFile(resolve(root, 'web-prepare', name), resolve(output, name));
await copyFile(resolve(root, 'LICENSE.txt'), resolve(output, 'LICENSE.txt'));
await writeFile(resolve(output, 'source.json'), JSON.stringify({ kind: 'local-browser-preparation', sources }, null, 2) + '\n');
console.log(`Built browser preparation draft with ${modules.size} shared modules; no dependencies downloaded.`);
