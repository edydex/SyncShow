'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Gitiles request metadata may change while pinned source bytes, modes and links remain mandatory', () => {
  const script = String.raw`
import importlib.util, pathlib, tempfile, tarfile, io, json, urllib.request
spec = importlib.util.spec_from_file_location('source_preparation', 'scripts/prepare-release-sources.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def archive(path, timestamp, content=b'Original source\n', mode=0o755, link='run.sh', duplicate=False, unsafe=None):
 with tarfile.open(path, 'w:gz') as out:
  info=tarfile.TarInfo('LICENSE');info.size=3;info.mtime=timestamp;info.uid=42;info.uname='transport-owner';out.addfile(info,io.BytesIO(b'MIT'))
  info=tarfile.TarInfo('run.sh');info.size=len(content);info.mode=mode;info.mtime=timestamp;out.addfile(info,io.BytesIO(content))
  info=tarfile.TarInfo('alias');info.type=tarfile.SYMTYPE;info.linkname=link;info.mtime=timestamp;out.addfile(info)
  if duplicate: out.addfile(tarfile.TarInfo('run.sh'), io.BytesIO(b''))
  if unsafe: out.addfile(tarfile.TarInfo(unsafe), io.BytesIO(b''))
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);first=root/'first.gz';second=root/'second.gz';a=root/'a.tar';b=root/'b.tar'
 archive(first,100);archive(second,200)
 module.canonicalize_gitiles_tar(first,a);module.canonicalize_gitiles_tar(second,b)
 assert first.read_bytes()!=second.read_bytes()
 assert a.read_bytes()==b.read_bytes(), 'Request-time metadata must not change source identity'
 record={'id':'fixture','url':'https://source.test/fixed-commit.tar.gz','fileName':'fixture.tar','archiveNormalization':'gitiles-tar-v1','bytes':a.stat().st_size,'sha256':module.digest(a)}
 module.time.sleep=lambda _:None
 def obtain(input_file, cache_name):
  module.urllib.request.urlopen=lambda *args,**kwargs:io.BytesIO(input_file.read_bytes())
  cache=root/cache_name;cache.mkdir();return module.obtain(record,cache)
 assert obtain(second,'good').read_bytes()==a.read_bytes()
 for index,change in enumerate([{'content':b'Changed source\n'},{'mode':0o644},{'link':'LICENSE'}]):
  altered=root/('altered'+str(index)+'.gz');archive(altered,300,**change)
  try: obtain(altered,'bad'+str(index));raise AssertionError('Changed source was accepted')
  except ValueError as error: assert 'SHA-256 changed' in str(error)
 for index,change in enumerate([{'duplicate':True},{'unsafe':'../escape'},{'link':'../escape'},{'unsafe':'/absolute'}]):
  altered=root/('unsafe'+str(index)+'.gz');archive(altered,300,**change)
  try: module.canonicalize_gitiles_tar(altered,root/'invalid.tar');raise AssertionError('Unsafe archive was accepted')
  except ValueError: pass
 print(json.dumps({'metadataDrift':'accepted','sourceModeAndLinkChanges':'rejected','unsafeAndDuplicatePaths':'rejected'}))
`;
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-B', '-c', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { metadataDrift: 'accepted',
    sourceModeAndLinkChanges: 'rejected', unsafeAndDuplicatePaths: 'rejected' });
});
