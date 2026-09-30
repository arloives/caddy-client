import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CaddyClient, CaddyHttpError, CaddyRequestError } from '../dist/index.js';

function mock(reply = new Response('{}'), options = {}) {
  const calls = [];
  const client = new CaddyClient({ ...options, fetch: async (url, init) => {
    calls.push({ url: String(url), ...init });
    return typeof reply === 'function' ? reply(url, init) : reply;
  }});
  return { client, calls };
}

test('getConfig returns config and the exact ETag; safe local defaults', async () => {
  const {client, calls} = mock(new Response('{"apps":{}}', {headers:{ETag:'"/config/ 123"'}}));
  assert.deepEqual(await client.getConfig(), {config:{apps:{}}, etag:'"/config/ 123"'});
  assert.equal(calls[0].url, 'http://localhost:2019/config/');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[0].headers.get('origin'), 'http://localhost:2019');
});

test('preserves reverse-proxy prefix and safely encodes keys', async () => {
  const {client, calls} = mock(new Response('null'), {baseUrl:'https://example.test/admin', headers:{Authorization:'Bearer token'}});
  await client.getConfig(['apps','space #? key',0]);
  assert.equal(calls[0].url,'https://example.test/admin/config/apps/space%20%23%3F%20key/0');
  assert.equal(calls[0].headers.get('authorization'),'Bearer token');
});

for (const path of [['..'], ['.'], [''], ['a/b'], ['a\\b'], ['%2e%2e'], ['a\n'], [-1], [0.5], [NaN], ['\ud800'], '/load']) {
  test(`rejects ambiguous config path ${JSON.stringify(path)}`, async () => {
    const {client,calls} = mock();
    await assert.rejects(client.getConfig(path), TypeError);
    assert.equal(calls.length, 0);
  });
}

for (const url of ['ftp://example.test','/relative','http://user:secret@example.test','http://example.test/?token=secret','http://example.test/#secret']) {
  test(`rejects unsafe base URL ${url.split('://')[0]}`, () => {
    assert.throws(() => new CaddyClient({baseUrl:url}), error => error instanceof TypeError && !error.message.includes('secret'));
  });
}

for (const timeoutMs of [0,-1,1.1,NaN,Infinity,2_147_483_648]) {
  test(`rejects invalid timeout ${timeoutMs}`, () => assert.throws(() => new CaddyClient({timeoutMs}), TypeError));
}

test('POST, PUT, PATCH, and DELETE preserve method, value and precondition', async () => {
  const {client,calls} = mock(() => new Response(null));
  await client.postConfig(['apps','list','...'],[1,2], {ifMatch:'"/config/ abc"'});
  await client.putConfig(['apps','list',0], 'first');
  await client.patchConfig(['apps','flag'], false);
  await client.deleteConfig(['apps','old']);
  assert.deepEqual(calls.map(c => c.method), ['POST','PUT','PATCH','DELETE']);
  assert.deepEqual(calls.map(c => c.body), ['[1,2]','"first"','false',undefined]);
  assert.equal(calls[0].headers.get('if-match'),'"/config/ abc"');
  assert.equal(calls[0].headers.get('content-type'),'application/json');
  assert.equal(calls[3].headers.get('content-type'),null);
});

test('root delete requires an explicit path', async () => {
  const {client,calls} = mock(new Response(null));
  await assert.rejects(client.deleteConfig(),TypeError);
  await client.deleteConfig([]);
  assert.equal(calls[0].url,'http://localhost:2019/config/');
});

test('valid JSON null, scalars and reused objects are preserved', async () => {
  const {client,calls} = mock(() => new Response(null));
  const item = {ok:true};
  await client.patchConfig(['x'],null);
  await client.postConfig(['x'],[item,item]);
  assert.equal(calls[0].body,'null');
  assert.equal(calls[1].body,'[{"ok":true},{"ok":true}]');
});

test('rejects lossy and circular JSON before making a request', async () => {
  const {client,calls} = mock();
  const cycle = {}; cycle.self = cycle;
  for (const value of [NaN, Infinity, new Date(), {x:undefined}, {x:()=>1}, [undefined], Array(1), 1n, cycle]) {
    await assert.rejects(client.postConfig(['x'],value),TypeError);
  }
  assert.equal(calls.length,0);
});

test('load sends JSON and forced reload header; normalizes empty success', async () => {
  const {client,calls} = mock(new Response(null));
  assert.deepEqual(await client.load({apps:{}},{forceReload:true}),{warnings:[]});
  assert.equal(calls[0].url,'http://localhost:2019/load');
  assert.equal(calls[0].body,'{"apps":{}}');
  assert.equal(calls[0].headers.get('cache-control'),'must-revalidate');
});

test('text load keeps newlines and returns adaptation warnings', async () => {
  const warning = {file:'Caddyfile',line:2,message:'formatting'};
  const {client,calls} = mock(new Response(JSON.stringify({warnings:[warning]})));
  assert.deepEqual(await client.load(':8080 {\n respond ok\n}\n',{contentType:'text/caddyfile'}),{warnings:[warning]});
  assert.equal(calls[0].headers.get('content-type'),'text/caddyfile');
  assert.equal(calls[0].body,':8080 {\n respond ok\n}\n');
});

test('text load requires explicit content type; JSON load requires an object', async () => {
  const {client,calls} = mock();
  await assert.rejects(client.load('text'),TypeError);
  for (const value of [null,[],1]) await assert.rejects(client.load(value),TypeError);
  assert.equal(calls.length,0);
});

test('adapt reads the actual result/warnings envelope without loading', async () => {
  const {client,calls} = mock(new Response('{"result":{"apps":{}},"warnings":[{"message":"note"}]}'));
  assert.deepEqual(await client.adapt('source'),{result:{apps:{}},warnings:[{message:'note'}]});
  assert.equal(calls[0].url,'http://localhost:2019/adapt');
  assert.equal(calls[0].headers.get('content-type'),'text/caddyfile');
});

test('adapt normalizes absent warnings', async () => {
  assert.deepEqual(await mock(new Response('{"result":null}')).client.adapt('{}',{contentType:'application/json'}),{result:null,warnings:[]});
});

for (const body of ['', 'not json', '{}', '{"result":{},"warnings":null}', '{"result":{},"warnings":[{"line":"1"}]}']) {
  test(`malformed adaptation response ${body}`, async () => {
    await assert.rejects(mock(new Response(body)).client.adapt('source'), error => error instanceof CaddyRequestError && error.code === 'invalid-response');
  });
}

test('HTTP errors expose status/method but never response secrets; no retries', async () => {
  const {client,calls} = mock(new Response('{"error":"secret password"}',{status:412}));
  await assert.rejects(client.patchConfig(['x'],{password:'secret'}), error => {
    assert.ok(error instanceof CaddyHttpError);
    assert.equal(error.status,412);
    assert.equal(error.method,'PATCH');
    assert.ok(!JSON.stringify(error).includes('secret'));
    assert.ok(!error.stack.includes('secret'));
    return true;
  });
  assert.equal(calls.length,1);
});

test('network errors do not retain credential-bearing causes', async () => {
  const {client,calls} = mock(() => {throw new Error('https://name:secret@example.test');});
  await assert.rejects(client.getConfig(),error => error instanceof CaddyRequestError && error.code === 'network' && error.cause === undefined && !error.stack.includes('secret'));
  assert.equal(calls.length,1);
});

test('timeout aborts a stalled transport, without retrying', async () => {
  const {client,calls} = mock(() => new Promise(()=>{}),{timeoutMs:15});
  await assert.rejects(client.getConfig(),error => error.code === 'timeout');
  assert.equal(calls[0].signal.aborted,true);
  assert.equal(calls.length,1);
});

test('timeout covers response body consumption', async () => {
  const body = new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('{'));}});
  const {client} = mock(new Response(body),{timeoutMs:15});
  await assert.rejects(client.getConfig(),error => error.code === 'timeout');
});

test('pre-aborted signal prevents a request', async () => {
  const {client,calls} = mock();
  const controller = new AbortController(); controller.abort('secret');
  await assert.rejects(client.getConfig([],{signal:controller.signal}),error => error.code === 'aborted');
  assert.equal(calls.length,0);
});

test('external cancellation aborts the request and strips its reason', async () => {
  const {client,calls} = mock(()=>new Promise(()=>{}));
  const controller = new AbortController();
  const request = client.getConfig([],{signal:controller.signal});
  controller.abort('secret');
  await assert.rejects(request,error => error.code === 'aborted' && !String(error).includes('secret'));
  assert.equal(calls[0].signal.aborted,true);
});

test('a real HTTP fixture observes the wire contract and rejects redirects', async t => {
  let redirected = false;
  const server = createServer((req,res) => {
    if (req.url === '/config/redirect') {res.writeHead(307,{location:'/leak'});res.end();return;}
    if (req.url === '/leak') {redirected=true;res.end('{}');return;}
    assert.equal(req.method,'GET');
    assert.equal(req.url,'/config/apps');
    res.writeHead(200,{'content-type':'application/json',etag:'"/config/apps abc"'});
    res.end('{"http":{}}');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections();server.close(resolve);}));
  const client = new CaddyClient({baseUrl:`http://127.0.0.1:${server.address().port}`});
  assert.deepEqual(await client.getConfig(['apps']),{config:{http:{}},etag:'"/config/apps abc"'});
  await assert.rejects(client.getConfig(['redirect']),error => error.code === 'network');
  assert.equal(redirected,false);
});

test('header validation never leaks invalid secret values', async () => {
  assert.throws(() => new CaddyClient({headers:{Authorization:'Bearer secret\nvalue'}}), error => error instanceof TypeError && !String(error).includes('secret'));
  const {client,calls} = mock();
  for (const action of [() => client.adapt('x',{contentType:'secret\nvalue'}), () => client.load('x',{contentType:'secret\nvalue'}), () => client.patchConfig(['x'],1,{ifMatch:'secret\nvalue'})]) {
    await assert.rejects(action,error => error instanceof TypeError && !String(error).includes('secret'));
  }
  assert.equal(calls.length,0);
});

test('serialization ignores toJSON hooks and rejects accessors without executing them', async () => {
  const {client,calls} = mock(() => new Response(null));
  const array = Object.assign([],{toJSON:()=>({admin:{disabled:true}})});
  const object = Object.defineProperty({ok:true},'toJSON',{value:()=>{throw new Error('secret');}});
  await client.postConfig(['x'],array);
  await client.postConfig(['x'],object);
  let called = false;
  await assert.rejects(client.postConfig(['x'],{get x(){called=true;throw new Error('secret');}}),error => error instanceof TypeError && !String(error).includes('secret'));
  await assert.rejects(client.postConfig(['x'],undefined),TypeError);
  assert.equal(called,false);
  assert.deepEqual(calls.map(call => call.body),['[]','{"ok":true}']);
});


test('explicit trusted proxy Origin is preserved', async () => {
  const {client,calls} = mock(new Response('{}'), {baseUrl:'https://proxy.test/admin', headers:{Origin:'https://admin.test'}});
  await client.getConfig();
  assert.equal(calls[0].headers.get('origin'),'https://admin.test');
});


test('load normalizes the bare warning array used by Caddy 2.11', async () => {
  const {client} = mock(new Response('[{"line":2,"message":"formatting"}]'));
  assert.deepEqual(await client.load('source',{contentType:'text/caddyfile'}),{warnings:[{line:2,message:'formatting'}]});
});
