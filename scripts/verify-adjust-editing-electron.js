'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

async function main() {
  assert(process.env.SYNCSHOW_ADJUST_EDITING_FIXTURE,'Set SYNCSHOW_ADJUST_EDITING_FIXTURE to the built Community native-adjust fixture.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-adjust-editing-')));
  const resultPath = path.join(root, 'result.json');
  const env = {...process.env, SYNCSHOW_TEST_USER_DATA_DIR:root, SYNCSHOW_UNIFIED_RESULT:resultPath,
    SYNCSHOW_ADJUST_EDITING_FIXTURE:process.env.SYNCSHOW_ADJUST_EDITING_FIXTURE, SYNCSHOW_GRID_REHEARSAL:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const run = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(__dirname,'fixtures','unified-prepare-electron-app.js'), '--syncshow-test-user-data', '--headless'],
      {cwd:path.join(__dirname,'..'), env, stdio:['ignore','pipe','pipe']});
    let log='';const collect=chunk=>{log=(log+chunk.toString()).slice(-32000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timeout = setTimeout(()=>child.kill('SIGTERM'),90000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('close',code=>{clearTimeout(timeout);resolve({code,log});});
  });
  await fs.writeFile(path.join(root,'rehearsal.log'),run.log);
  const result=JSON.parse(await fs.readFile(resultPath,'utf8'));
  assert.equal(result.ok,true,JSON.stringify({...result,root,log:run.log}));
  assert.equal(run.code,0);
  console.log(JSON.stringify({...result,root},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
