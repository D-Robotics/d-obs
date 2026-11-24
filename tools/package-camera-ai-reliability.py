#!/usr/bin/env python3
"""Overlay the narrowly scoped Studio workflow fix on the verified 1.5.5 package."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PLUGIN_ID = 'rdk-camera-workshop'
VERSION = '1.5.7'
BASE_MANIFEST_SHA256 = 'aa8c43e06f5868830aab40136519d67cf34db2aabd1fb9d7d963b347d9010bc6'
MANIFEST = 'SOURCE-MANIFEST.json'
PATCH = Path(__file__).with_name('camera-ai-reliability-157.patch').resolve()
PATCHED_FILES = {
    '.mcp.json', 'mcp/bridge.mjs', 'mcp/server.mjs', 'mcp/studio-config.mjs',
    'mcp/workbench-session.mjs', 'skills/rdk-camera-workshop/SKILL.md',
    'skills/rdk-vision-workshop/SKILL.md',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def read_package(base):
    manifest_file = base / MANIFEST
    if manifest_file.is_symlink():
        raise ValueError('Expected the original source manifest file')
    manifest_bytes = manifest_file.read_bytes()
    if digest(manifest_bytes) != BASE_MANIFEST_SHA256:
        raise ValueError('Expected the verified Camera AI 1.5.5 source manifest')
    manifest = json.loads(manifest_bytes)
    entries = {}
    for entry in manifest['files']:
        name = entry['path']
        if name in entries or name == MANIFEST or not PurePosixPath(name).parts:
            raise ValueError(f'Invalid inventory entry: {name}')
        file = base / name
        if not file.resolve().is_relative_to(base) or file.resolve() != file:
            raise ValueError(f'Invalid package path: {name}')
        data = file.read_bytes()
        if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
            raise ValueError(f'Base file failed verification: {name}')
        entries[name] = data
    return manifest, entries


def apply_overlay(original):
    with tempfile.TemporaryDirectory(prefix='camera-ai-overlay-') as temporary:
        root = Path(temporary)
        for name, data in original.items():
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        git = shutil.which('git')
        if not git:
            raise ValueError('Git is required to apply the reviewed source overlay')
        subprocess.run([git, 'apply', '--whitespace=error', str(PATCH)], cwd=root, check=True)
        entries = {file.relative_to(root).as_posix(): file.read_bytes()
                   for file in root.rglob('*') if file.is_file()}
    if entries.keys() != original.keys() or {name for name in entries if entries[name] != original[name]} != PATCHED_FILES:
        raise ValueError('Source overlay changed unexpected files')
    return entries


def package(base, output):
    manifest, original = read_package(base.resolve())
    entries = apply_overlay(original)
    plugin = json.loads(entries['plugin.json'])
    entries['plugin.json'] = encoded({**plugin, 'version': VERSION})
    entries['README.md'] = entries['README.md'].replace(b'# RDK Camera AI 1.5.5', b'# RDK Camera AI 1.5.7', 1)
    # Record the immediate source manifest instead of inheriting the earlier release's archive hash.
    manifest.pop('extendsSha256', None)
    entries[MANIFEST] = encoded({
        **manifest, 'version': VERSION, 'baseVersion': '1.5.5',
        'baseSourceManifestSha256': BASE_MANIFEST_SHA256, 'overlaySha256': digest(PATCH.read_bytes()),
        'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)}
                  for name, data in sorted(entries.items())],
    })

    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f'rdk-camera-ai-{VERSION}.zip'
    paths = {f'{PLUGIN_ID}/{name}': data for name, data in entries.items()}
    with ZipFile(archive_path, 'x') as archive:
        for name, data in sorted(paths.items()):
            member = ZipInfo(name)
            member.external_attr = 0o100644 << 16
            archive.writestr(member, data, compress_type=ZIP_DEFLATED)
    with ZipFile(archive_path) as archive:
        if (archive.testzip() is not None or len(archive.namelist()) != len(paths)
                or set(archive.namelist()) != set(paths)
                or any(archive.read(name) != data for name, data in paths.items())):
            raise ValueError('Release archive failed independent member validation')
    print(json.dumps({'archive': str(archive_path), 'version': VERSION,
                      'sha256': digest(archive_path.read_bytes()), 'files': len(paths)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-directory', required=True, type=Path, help='Verified extracted 1.5.5 plugin directory')
    parser.add_argument('--output', required=True, type=Path, help='Directory for the 1.5.7 release ZIP')
    args = parser.parse_args()
    package(args.base_directory, args.output)


if __name__ == '__main__':
    main()
