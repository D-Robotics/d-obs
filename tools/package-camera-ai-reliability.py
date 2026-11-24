#!/usr/bin/env python3
"""Build a Camera AI release from a verified baseline and a reviewed source overlay."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


PLUGIN_ID = 'rdk-camera-workshop'
MANIFEST = 'SOURCE-MANIFEST.json'
RELIABILITY_FILES = {
    '.mcp.json', 'mcp/bridge.mjs', 'mcp/server.mjs', 'mcp/studio-config.mjs',
    'mcp/workbench-session.mjs', 'skills/rdk-camera-workshop/SKILL.md',
    'skills/rdk-vision-workshop/SKILL.md',
}

DELIVERY_FILES = {
    'WORKSHOP.md', 'mcp/bridge.mjs', 'mcp/server.mjs', 'mcp/workbench.mjs', 'mcp/workbench-session.mjs',
    'skills/rdk-camera-workshop/SKILL.md', 'skills/rdk-vision-workshop/SKILL.md',
    'web/app.mjs', 'web/board-panel.mjs', 'web/capture-panel.mjs',
    'web/index.html', 'web/isp-panel.mjs', 'web/style.css',
}

# version -> (base version, pinned base source manifest SHA-256, overlay, edited files)
RELEASES = {
    '1.5.7': ('1.5.5', 'aa8c43e06f5868830aab40136519d67cf34db2aabd1fb9d7d963b347d9010bc6',
              'camera-ai-reliability-157.patch', RELIABILITY_FILES),
    '1.5.8': ('1.5.7', '9266bc450aab1f561fe5a1348439d3f000caed011dcc660a1ab5f81ac8221c0f',
              'camera-ai-delivery-158.patch', DELIVERY_FILES),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def read_package(base, expected_version, manifest_sha256):
    manifest_file = base / MANIFEST
    if manifest_file.is_symlink():
        raise ValueError('Expected the original source manifest file')
    manifest_bytes = manifest_file.read_bytes()
    if digest(manifest_bytes) != manifest_sha256:
        raise ValueError(f'Expected the verified Camera AI {expected_version} source manifest')
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


def apply_overlay(original, patch, edited_files):
    with tempfile.TemporaryDirectory(prefix='camera-ai-overlay-') as temporary:
        root = Path(temporary)
        for name, data in original.items():
            file = root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        git = shutil.which('git')
        if not git:
            raise ValueError('Git is required to apply the reviewed source overlay')
        subprocess.run([git, 'apply', '--whitespace=error', str(patch)], cwd=root, check=True)
        entries = {file.relative_to(root).as_posix(): file.read_bytes()
                   for file in root.rglob('*') if file.is_file()}
    if entries.keys() != original.keys() or {name for name in entries if entries[name] != original[name]} != edited_files:
        raise ValueError('Source overlay changed unexpected files')
    return entries


def package(base, output, version='1.5.7'):
    base_version, manifest_sha256, patch_name, edited_files = RELEASES[version]
    patch = Path(__file__).with_name(patch_name).resolve()
    manifest, original = read_package(base.resolve(), base_version, manifest_sha256)
    entries = apply_overlay(original, patch, edited_files)
    plugin = json.loads(entries['plugin.json'])
    entries['plugin.json'] = encoded({**plugin, 'version': version})
    entries['README.md'] = entries['README.md'].replace(
        f'# RDK Camera AI {base_version}'.encode(), f'# RDK Camera AI {version}'.encode(), 1)
    # Record the immediate source manifest instead of inheriting the earlier release's archive hash.
    manifest.pop('extendsSha256', None)
    entries[MANIFEST] = encoded({
        **manifest, 'version': version, 'baseVersion': base_version,
        'baseSourceManifestSha256': manifest_sha256, 'overlaySha256': digest(patch.read_bytes()),
        'files': [{'path': name, 'bytes': len(data), 'sha256': digest(data)}
                  for name, data in sorted(entries.items())],
    })

    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / f'rdk-camera-ai-{version}.zip'
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
    print(json.dumps({'archive': str(archive_path), 'version': version,
                      'sha256': digest(archive_path.read_bytes()), 'files': len(paths)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-directory', required=True, type=Path, help='Verified extracted baseline plugin directory')
    parser.add_argument('--output', required=True, type=Path, help='Directory for the release ZIP')
    parser.add_argument('--version', choices=RELEASES, default='1.5.7', help='Release to build')
    args = parser.parse_args()
    package(args.base_directory, args.output, args.version)


if __name__ == '__main__':
    main()
