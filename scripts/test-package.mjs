// Exercise the tarball like an external ESM + TypeScript consumer, not a relative source import.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root = process.cwd();
const directory = mkdtempSync(join(tmpdir(),'caddy-client-consumer-'));
try {
  const result = JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',directory],{cwd:root,encoding:'utf8'}));
  const packed = result[0];
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('dist/index.d.ts'));
  assert.ok(!files.some(file => file.includes('node_modules') || file.startsWith('src/') || file.startsWith('test/')));
  writeFileSync(join(directory,'package.json'),JSON.stringify({name:'consumer',private:true,type:'module'}));
  execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(directory,packed.filename)],{cwd:directory,stdio:'inherit'});
  const runtime = `import { CaddyClient, CaddyHttpError } from '@arloives/caddy-client';
const client = new CaddyClient({fetch:async()=>new Response('{"ok":true}')});
const {config} = await client.getConfig();
if(config.ok !== true || new CaddyHttpError(412,'PATCH').status !== 412) throw new Error('package import failed');`;
  writeFileSync(join(directory,'index.mjs'),runtime);
  execFileSync(process.execPath,['index.mjs'],{cwd:directory,stdio:'inherit'});
  writeFileSync(join(directory,'index.ts'),`import {CaddyClient,type ConfigPath,type JsonValue} from '@arloives/caddy-client';
const client = new CaddyClient();
const path: ConfigPath = ['apps','http',0];
const {config,etag} = await client.getConfig<{answer:number}>(path);
const answer: number = config.answer;
const value: JsonValue = {answer};
await client.patchConfig(path,value,etag ? {ifMatch:etag}:{});
await client.load('text',{contentType:'text/caddyfile'});
// @ts-expect-error Text load requires contentType
await client.load('text');
// @ts-expect-error Paths are segments, not slash-separated strings
await client.getConfig('/apps');
// @ts-expect-error /load does not implement optimistic concurrency
await client.load({}, {ifMatch:'tag'});
`);
  execFileSync(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022','--typeRoots',resolve(root,'node_modules/@types'),'--types','node','index.ts'],{cwd:directory,stdio:'inherit'});
  console.log(`Packed consumer passed (${packed.size} bytes; ESM exports and TypeScript declarations)`);
} finally {rmSync(directory,{recursive:true,force:true});}
