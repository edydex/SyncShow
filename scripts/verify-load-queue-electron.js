'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-load-queue-')));
  const resultPath = path.join(root, 'result.json');
  const env = {...process.env, SYNCSHOW_TEST_USER_DATA_DIR:root, SYNCSHOW_UNIFIED_RESULT:resultPath,
    SYNCSHOW_LOAD_QUEUE_FIXTURE:'1', SYNCSHOW_GRID_REHEARSAL:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const run = await new Promise(resolve => {
    const child = spawn(require('electron'), [path.join(__dirname,'fixtures','unified-prepare-electron-app.js'), '--syncshow-test-user-data', '--headless'],
      {cwd:path.join(__dirname,'..'), env, stdio:['ignore','pipe','pipe']});
    let log='',timedOut=false,forceKill;const collect=chunk=>{log=(log+chunk.toString()).slice(-32000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timeout = setTimeout(()=>{timedOut=true;child.kill('SIGTERM');forceKill=setTimeout(()=>child.kill('SIGKILL'),2000);},90000);
    const clearTimers=()=>{clearTimeout(timeout);clearTimeout(forceKill);};
    child.once('error',error=>{clearTimers();resolve({code:null,error:error.message,timedOut,log});});
    child.once('close',(code,signal)=>{clearTimers();resolve({code,signal,timedOut,log});});
  });
  await fs.writeFile(path.join(root,'rehearsal.log'),run.log);
  assert.equal(run.code,0,`Native rehearsal failed before a complete result: ${JSON.stringify({...run,root})}`);
  const result=JSON.parse(await fs.readFile(resultPath,'utf8'));
  assert.equal(result.ok,true,JSON.stringify({...result,root,log:run.log}));
  console.log(JSON.stringify({...result,root},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
