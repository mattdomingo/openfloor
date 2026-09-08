import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chownSync, chmodSync } from "node:fs";
import http from "node:http";
import { sandboxArguments, startSandbox } from "./runtime-sandbox.mjs";
import { brokerConfiguration, createBroker } from "./runtime-broker.mjs";

// Executes against the exact production image, never a substitute launcher.
mkdirSync("/workspace/repository", { recursive: true });
mkdirSync("/tmp/openfloor/provider-home", { recursive: true });
writeFileSync("/root/isolation-secret", "private-file-canary");
writeFileSync("/tmp/host-secret", "private-file-canary");
spawnSync("chown", ["-R", "10002:10001", "/workspace/repository", "/tmp/openfloor"]);
function isolated(script, options = {}) {
  const result = spawnSync("/usr/bin/bwrap", sandboxArguments(["node", "--input-type=module", "-e", script], {}, options), {
    encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", PRIVATE_TEST_SECRET: "private-environment-canary" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert(!result.stdout.includes("private-environment-canary"));
  return result.stdout;
}
isolated(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import net from 'node:net';
  import { spawnSync } from 'node:child_process';
  assert.equal(process.getuid(), 10002);
  assert.equal(process.getgid(), 10001);
  const temporary = fs.mkdtempSync('/tmp/workspace-tool-');
  fs.writeFileSync(temporary + '/output', 'private temporary file');
  assert.equal(fs.readFileSync(temporary + '/output', 'utf8'), 'private temporary file');
  const status = fs.readFileSync('/proc/self/status','utf8');
  assert.match(status, /NoNewPrivs:\\s+1/);
  for (const capability of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.match(status, new RegExp(capability + ':\\\\s+0+'));
  for (const file of ['/root/isolation-secret','/tmp/host-secret','/container-server','/opt/openfloor/runtime-broker.mjs','/opt/openfloor/publish-bundle.mjs','/opt/openfloor/read-run-artifact.mjs','/proc/1/root/root/isolation-secret']) assert.throws(() => fs.readFileSync(file));
  assert.equal(process.env.PRIVATE_TEST_SECRET, undefined);
  for (const entry of fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name))) {
    try { assert(!fs.readFileSync('/proc/'+entry+'/environ','utf8').includes('private-environment-canary')); }
    catch (error) { if (error.code !== 'EACCES' && error.code !== 'ENOENT') throw error; }
  }
  assert.throws(() => fs.writeFileSync('/opt/openfloor/codex-runner.mjs','hostile'));
  assert.throws(() => fs.writeFileSync('/usr/bin/hostile','hostile'));
  assert.notEqual(spawnSync('/usr/bin/setpriv',['--reuid=0','id']).status,0);
  await new Promise((resolve,reject) => {
    const socket=net.connect({host:'1.1.1.1',port:443});
    socket.on('connect',() => { socket.destroy(); reject(new Error('Network escaped')); });
    socket.on('error',resolve); socket.setTimeout(1000,() => {socket.destroy();resolve();});
  });
  fs.writeFileSync('/workspace/repository/native-file','native edit');
  fs.writeFileSync('/tmp/openfloor/native-scratch','scratch');
`);
assert.equal(readFileSync("/workspace/repository/native-file", "utf8"), "native edit");
isolated(`import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.throws(() => fs.writeFileSync('/workspace/repository/native-file','changed'));`, { readOnly: true });
// Repository Git filters must execute credential-free inside the same boundary.
isolated(`
 import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
 const git=(...args)=>execFileSync('git',args);
 git('init'); git('config','filter.hostile.clean','env > /tmp/openfloor/filter-env; id -u > /tmp/openfloor/filter-uid; cat');
 fs.writeFileSync('.gitattributes','native-file filter=hostile\\n'); git('add','.');
`);
assert.equal(readFileSync("/tmp/openfloor/filter-uid", "utf8").trim(), "10002");
assert(!readFileSync("/tmp/openfloor/filter-env", "utf8").includes("private-environment-canary"));
// Detached descendants cannot survive namespace completion and race artifact reads.
isolated(`import {spawn} from 'node:child_process'; const child=spawn('/bin/bash',['-c','sleep 1; echo escaped > /tmp/openfloor/survivor'],{detached:true,stdio:'ignore'}); child.unref();`);
await new Promise(resolve => setTimeout(resolve, 1500));
assert(!existsSync("/tmp/openfloor/survivor"));
// The real namespace bridge reaches only pinned broker routes. Its child sees
// placeholders, while the outside mock gateway receives the private token.
const upstream = http.createServer((request, response) => {
  assert.equal(request.headers.authorization, "Bearer private-gateway-canary");
  assert.equal(request.url, "/v1/responses");
  response.end("broker transport works");
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const { environment, routes } = brokerConfiguration({ OPENFLOOR_OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, OPENFLOOR_OPENAI_TOKEN: "private-gateway-canary" });
const broker = createBroker(routes);
const socket = "/run/isolation-broker.sock";
await new Promise(resolve => broker.listen(socket, resolve));
chmodSync(socket, 0o600); chownSync(socket, 10002, 10001);
function bridgeChild(script) {
  return startSandbox(["node", "/opt/openfloor/runtime-bridge.mjs", "node", "--input-type=module", "-e", script], environment, { brokerPath: socket });
}
function exit(child) {
  return new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
}
assert.equal(await exit(bridgeChild(`
  import assert from 'node:assert/strict';
  assert.equal(process.env.OPENFLOOR_OPENAI_TOKEN,'openfloor-broker-placeholder');
  const response=await fetch(process.env.OPENFLOOR_OPENAI_BASE_URL+'/responses',{method:'POST'});
  assert.equal(await response.text(),'broker transport works');
  assert.equal((await fetch('http://127.0.0.1:45871/unknown')).status,403);
`)), 0);
// A provider that ignores cancellation still loses all descendants within the
// bridge shutdown deadline. Artifacts are consumed only after this exit.
const stubborn = bridgeChild(`
  import fs from 'node:fs'; import {spawn} from 'node:child_process';
  process.on('SIGTERM',()=>fs.writeFileSync('/tmp/openfloor/cancel-flushed','flushed'));
  spawn('/bin/bash',['-c','sleep 12; echo escaped > /tmp/openfloor/cancel-survivor'],{detached:true,stdio:'ignore'}).unref();
  fs.writeFileSync('/tmp/openfloor/cancel-ready','ready'); setInterval(()=>{},1000);
`);
const stopped = exit(stubborn);
for (let attempt = 0; !existsSync("/tmp/openfloor/cancel-ready"); attempt++) {
  assert(attempt < 100, "Cancellation probe did not start");
  await new Promise(resolve => setTimeout(resolve, 100));
}
stubborn.kill("SIGTERM");
await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("Cancellation did not stop namespace")), 11_000).unref())]);
assert(existsSync("/tmp/openfloor/cancel-flushed"), "Cancellation did not reach runner");
await new Promise(resolve => setTimeout(resolve, 4500));
assert(!existsSync("/tmp/openfloor/cancel-survivor"));
broker.closeAllConnections(); broker.close(); upstream.closeAllConnections(); upstream.close();
console.log("runtime-isolation-ok: native files, host files, proc, capabilities, network, read-only, hostile Git, broker transport, cancellation and descendant teardown");
