import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {CaddyClient,CaddyHttpError,CaddyRequestError} from '../dist/index.js';

// This test only starts and controls its own disposable, loopback-only Caddy process.
// It never uses CADDY_ADMIN, an existing server, or a user's Caddy config/data directories.
test('isolated Caddy: adaptation, load, CRUD, ETags, warnings, and rollback', {timeout:30_000}, async t => {
  assert.ok(process.env.CADDY_BIN,'Set CADDY_BIN to a trusted Caddy binary to run integration tests');
  const directory = await mkdtemp(join(tmpdir(),'caddy-client-integration-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const admin = {listen:`127.0.0.1:${port}`,config:{persist:false}};
  await writeFile(join(directory,'config.json'),JSON.stringify({admin}));
  const child = spawn(process.env.CADDY_BIN,['run','--config',join(directory,'config.json')],{
    cwd:directory,env:{PATH:process.env.PATH,HOME:directory,XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data')},stdio:['ignore','ignore','pipe'],
  });
  let logs = ''; let spawnError;
  child.stderr.on('data',chunk => {logs += chunk;});
  child.on('error',error => {spawnError=error;});
  t.after(async () => {
    if (child.exitCode === null && !spawnError) {
      const exited = once(child,'exit');
      child.kill('SIGTERM');
      const kill = setTimeout(()=>child.kill('SIGKILL'),2000);
      await exited;clearTimeout(kill);
    }
    await rm(directory,{recursive:true,force:true});
  });
  for (let i=0;i<200;i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Test Caddy exited before readiness: ${logs}`);
    if (logs.includes('admin endpoint started') && logs.includes(`127.0.0.1:${port}`)) break;
    await delay(25);
    if (i===199) throw new Error(`Test Caddy did not become ready: ${logs}`);
  }
  // Reloading replaces the admin listener; avoid pooling a just-closed socket in this lifecycle test.
  const client = new CaddyClient({baseUrl:`http://127.0.0.1:${port}`,timeoutMs:5000,headers:{Connection:"close"}});
  const waitForAdmin = async () => {
    // Reload can temporarily close/rebind the listener. Only readiness GETs are retried.
    await delay(25);
    const deadline = Date.now()+2000;
    for (;;) {
      try { await client.getConfig(); return; }
      catch (error) {
        if (!(error instanceof CaddyRequestError) || error.code !== 'network' || Date.now() >= deadline || child.exitCode !== null) throw error;
        await delay(25);
      }
    }
  };
  const wrongOrigin = new CaddyClient({baseUrl:`http://127.0.0.1:${port}`,headers:{Origin:'https://untrusted.invalid'}});
  await assert.rejects(wrongOrigin.getConfig(),error => error instanceof CaddyHttpError && error.status === 403);
  const caddyfile = `{\n\tadmin 127.0.0.1:${port}\n\tpersist_config off\n}\nhttp://127.0.0.1:0 {\n\trespond "hello"\n}\n`;
  const adapted = await client.adapt(caddyfile);
  assert.ok(adapted.result.apps.http);
  assert.deepEqual((await client.getConfig(['apps'])).config,null); // Adapt has not loaded anything.
  assert.deepEqual(await client.load(adapted.result),{warnings:[]});
  await waitForAdmin();
  const findHandler = (value, path=[]) => {
    if (!value || typeof value !== 'object') return undefined;
    if (value.handler === 'static_response') return path;
    for (const [key,child] of Object.entries(value)) {
      const found = findHandler(child,[...path,Array.isArray(value) ? Number(key) : key]);
      if (found) return found;
    }
  };
  const handler = findHandler(adapted.result);
  assert.ok(handler);
  assert.equal((await client.getConfig([...handler,'body'])).config,'hello');
  await client.patchConfig([...handler,'body'],'patched');
  await waitForAdmin();
  assert.equal((await client.getConfig([...handler,'body'])).config,'patched');
  await client.putConfig([...handler,'status_code'],201);
  await waitForAdmin();
  assert.equal((await client.getConfig([...handler,'status_code'])).config,201);
  await client.deleteConfig([...handler,'status_code']);
  await waitForAdmin();
  await client.postConfig([...handler,'headers'],{'X-Test':['yes']});
  await waitForAdmin();
  await client.postConfig([...handler,'headers','X-Test'],'again');
  await waitForAdmin();
  await client.postConfig([...handler,'headers','X-Test','...'],['third','fourth']);
  await waitForAdmin();
  assert.deepEqual((await client.getConfig([...handler,'headers','X-Test'])).config,['yes','again','third','fourth']);
  const initial = await client.getConfig(handler);
  assert.ok(initial.etag);
  await client.patchConfig([...handler,'body'],'fresh',{ifMatch:initial.etag});
  await waitForAdmin();
  await assert.rejects(client.patchConfig([...handler,'body'],'stale',{ifMatch:initial.etag}),error => error instanceof CaddyHttpError && error.status===412);
  assert.equal((await client.getConfig([...handler,'body'])).config,'fresh');
  // Adaptation can succeed even when provisioning would fail.
  const invalid = {...adapted.result,apps:{unknown_app_for_test:{}}};
  await assert.rejects(client.load(invalid),CaddyHttpError);
  await waitForAdmin();
  assert.equal((await client.getConfig([...handler,'body'])).config,'fresh');
  const textResult = await client.load(caddyfile,{contentType:'text/caddyfile',forceReload:true});
  assert.ok(Array.isArray(textResult.warnings));
  await waitForAdmin();
  const messy = caddyfile.replace('\trespond','respond');
  const warningResult = await client.adapt(messy);
  assert.ok(warningResult.warnings.length>0);
  const warningLoad = await client.load(messy,{contentType:'text/caddyfile'});
  assert.ok(warningLoad.warnings.length>0);
  await waitForAdmin();
  // Replace via /config with a root ETag and preserve this test's private admin address.
  const root = await client.getConfig();
  await client.postConfig([], {admin}, {ifMatch:root.etag});
  await waitForAdmin();
  assert.deepEqual((await client.getConfig(['apps'])).config,null);
});
