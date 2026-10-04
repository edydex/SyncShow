"""Build an immutable native source/notice asset from checksum-pinned inputs."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import urllib.request
import zipfile

PROJECT = Path(__file__).resolve().parent.parent


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def obtain(record, cache):
    destination = cache / record['fileName']
    if destination.is_symlink():
        raise ValueError('Source cache entry is a symlink: ' + record['id'])
    if destination.exists():
        if destination.stat().st_size == record['bytes'] and digest(destination) == record['sha256']:
            return destination
        raise ValueError('Source cache entry changed: ' + record['id'])
    error = None
    for attempt in range(4):
        temporary = destination.with_suffix('.download')
        try:
            request = urllib.request.Request(record['url'], headers={
                'User-Agent': 'SyncShow-source-distribution/2 (https://github.com/edydex/SyncShow)'
            })
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('xb') as output:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    output.write(chunk)
            if temporary.stat().st_size != record['bytes'] or digest(temporary) != record['sha256']:
                raise ValueError('Upstream source size or SHA-256 changed: ' + record['id'])
            temporary.replace(destination)
            return destination
        except Exception as caught:
            temporary.unlink(missing_ok=True)
            error = caught
            if attempt < 3:
                time.sleep(attempt + 1)
    raise error


def notice_files(record, archive):
    """Retain a conservative superset of source terms, including vendored terms."""
    notices = []
    with tarfile.open(archive, 'r:*') as source:
        for member in sorted(source.getmembers(), key=lambda entry: entry.name):
            if not member.isfile() or member.size < 1 or member.size > 2 * 1024 * 1024:
                continue
            name = Path(member.name).name
            if not re.search(r'^(license|licence|copying|copyright|notice|authors|patents|unlicense|ftl)([._-]|$)', name, re.I):
                continue
            text = source.extractfile(member).read().decode('utf-8', errors='replace')
            notices.append({
                'source': record['id'] + '@' + record['version'],
                'path': member.name,
                'text': text,
            })
    return notices


def add_bytes(archive, name, data):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_STORED
    archive.writestr(info, data)


def add_source(archive, name, source):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_STORED
    with archive.open(info, 'w', force_zip64=True) as output, source.open('rb') as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b''):
            output.write(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='dist')
    parser.add_argument('--cache', default=str(Path(tempfile.gettempdir()) / 'syncshow-native-source-cache'))
    args = parser.parse_args()
    output = Path(args.output).resolve()
    cache = Path(args.cache).resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    version = json.loads((PROJECT / 'package.json').read_text())['version']
    spec_bytes = (PROJECT / 'legal/release-sources/inputs.json').read_bytes()
    spec = json.loads(spec_bytes)
    inputs = spec['inputs']
    if len({entry['fileName'] for entry in inputs}) != len(inputs):
        raise ValueError('Duplicate source asset paths.')
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        downloaded = list(workers.map(lambda record: obtain(record, cache), inputs))
    notices = []
    for record, archive in zip(inputs, downloaded):
        notices.extend(notice_files(record, archive))
    aggregate = ''.join('\n\n===== ' + entry['source'] + ' / ' + entry['path'] + ' =====\n\n'
                        + entry['text'] for entry in notices).encode('utf-8')
    aggregate_sha = hashlib.sha256(aggregate).hexdigest()
    if aggregate_sha != spec['noticeSha256']:
        raise ValueError('Collected native notice terms changed from the reviewed source inventory.')
    source_name = f'SyncShow-{version}-corresponding-sources.zip'
    source_path = output / source_name
    temporary_path = output / (source_name + '.tmp')
    index = {
        'schemaVersion': 1,
        'version': version,
        'inputsManifestSha256': hashlib.sha256(spec_bytes).hexdigest(),
        'inputs': inputs,
        'noticeCount': len(notices),
        'noticeSha256': aggregate_sha,
        'scope': spec['scope'],
    }
    with zipfile.ZipFile(temporary_path, 'w', allowZip64=True) as archive:
        add_bytes(archive, 'SOURCE-INDEX.json', json_bytes(index))
        add_bytes(archive, 'THIRD-PARTY-NOTICES.txt', aggregate)
        add_bytes(archive, 'REBUILDING-AND-REPLACEMENT.md', (PROJECT / 'legal/release-sources/REBUILDING.md').read_bytes())
        for record, source in zip(inputs, downloaded):
            add_source(archive, 'sources/' + record['fileName'], source)
    temporary_path.replace(source_path)
    receipt = {
        'schemaVersion': 1,
        'version': version,
        'inputsManifestSha256': index['inputsManifestSha256'],
        'archiveInputCount': len(inputs),
        'noticeCount': len(notices),
        'noticeSha256': aggregate_sha,
        'archive': {
            'fileName': source_name,
            'size': source_path.stat().st_size,
            'sha256': digest(source_path),
            'downloadUrl': f'https://github.com/edydex/SyncShow/releases/download/v{version}/{source_name}',
        },
    }
    (output / 'release-source-receipt.json').write_bytes(json_bytes(receipt))
    print(json.dumps({'sourceAsset': source_name, 'inputs': len(inputs), 'noticeFiles': len(notices),
                      'bytes': receipt['archive']['size'], 'sha256': receipt['archive']['sha256']}))


if __name__ == '__main__':
    main()
