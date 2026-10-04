"""Build an immutable native source/notice asset from checksum-pinned inputs."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
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


def archive_path(raw, field):
    if not raw or '\\' in raw or '\0' in raw or raw.startswith('/'):
        raise ValueError('Unsafe Gitiles archive ' + field)
    path = PurePosixPath(raw)
    if '..' in path.parts or str(path) in ('', '.'):
        raise ValueError('Unsafe Gitiles archive ' + field)
    return str(path)


def canonicalize_gitiles_tar(archive, destination):
    """Pin source contents, modes and links; discard request-time tar metadata.

    Gitiles creates new member/PAX mtimes on every download. Uncompressed PAX
    output avoids compressor-version drift while preserving every source byte.
    """
    with tarfile.open(archive, 'r:*') as source:
        members = {}
        total_bytes = 0
        for member in source:
            name = archive_path(member.name, 'path')
            if name in members:
                raise ValueError('Duplicate Gitiles archive path: ' + name)
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsupported Gitiles archive member: ' + name)
            total_bytes += member.size
            if member.size < 0 or total_bytes > 2 * 1024 * 1024 * 1024:
                raise ValueError('Gitiles archive contents exceed the source bound.')
            if member.issym():
                target = member.linkname
                if not target or '\\' in target or '\0' in target or target.startswith('/'):
                    raise ValueError('Unsafe Gitiles symlink: ' + name)
                archive_path(posixpath.normpath(posixpath.join(posixpath.dirname(name), target)), 'symlink target')
            elif member.islnk():
                archive_path(member.linkname, 'hardlink target')
            members[name] = member
        for name in members:
            for parent in PurePosixPath(name).parents:
                if str(parent) in members and not members[str(parent)].isdir():
                    raise ValueError('Gitiles archive path has a non-directory parent: ' + name)
        with tarfile.open(destination, 'w', format=tarfile.PAX_FORMAT) as output:
            for name, member in sorted(members.items()):
                canonical = tarfile.TarInfo(name)
                canonical.type = member.type
                canonical.mode = member.mode
                canonical.linkname = member.linkname
                canonical.size = member.size if member.isfile() else 0
                # uid/gid/owner names/PAX mtimes are transport metadata only.
                canonical.uid = canonical.gid = canonical.mtime = 0
                output.addfile(canonical, source.extractfile(member) if member.isfile() else None)


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
        normalized = destination.with_suffix('.canonical')
        try:
            request = urllib.request.Request(record['url'], headers={
                'User-Agent': 'SyncShow-source-distribution/2 (https://github.com/edydex/SyncShow)'
            })
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('xb') as output:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    output.write(chunk)
            if record.get('archiveNormalization') == 'gitiles-tar-v1':
                canonicalize_gitiles_tar(temporary, normalized)
                temporary.unlink()
                normalized.replace(temporary)
            elif record.get('archiveNormalization'):
                raise ValueError('Unknown source archive normalization: ' + record['id'])
            if temporary.stat().st_size != record['bytes'] or digest(temporary) != record['sha256']:
                raise ValueError('Upstream source size or SHA-256 changed: ' + record['id'])
            temporary.replace(destination)
            return destination
        except Exception as caught:
            temporary.unlink(missing_ok=True)
            normalized.unlink(missing_ok=True)
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
