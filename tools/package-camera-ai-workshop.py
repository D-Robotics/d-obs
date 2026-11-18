#!/usr/bin/env python3
"""Build one Studio extension from a released Camera AI and the 180-minute course."""
import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
CAMERA_ID = 'rdk-camera-workshop'
COURSE_ID = 'rdk-vision-workshop'
VERSION = '1.4.2'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def add_file(destination, root, rel):
    path = root / rel
    if path.resolve() != path or not path.is_file() or rel in destination:
        raise ValueError(f'Invalid source or duplicate package entry: {rel}')
    data = path.read_bytes()
    if re.search(r'/Users/|192\.168\.\d+\.\d+|sk-[A-Za-z0-9_-]{16,}|BEGIN [A-Z ]*PRIVATE KEY', data.decode('utf-8')):
        raise ValueError(f'Private data in package entry: {rel}')
    destination[rel] = data


def add_tree(destination, root, folder, suffixes):
    for path in sorted((root / folder).rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlink in source tree: {path}')
        if path.is_file() and path.suffix in suffixes and '.test.' not in path.name:
            add_file(destination, root, path.relative_to(root).as_posix())


def package(camera, course, out):
    camera_manifest = load(camera / 'plugin.json')
    course_manifest = load(course / 'plugin.json')
    if (camera_manifest['name'] != CAMERA_ID or camera_manifest['version'] not in ('1.3.0', '1.4.1')
            or course_manifest['name'] != COURSE_ID):
        raise ValueError('Expected Camera AI 1.3.0 or the 1.4.1 release and the 180-minute Vision Workshop source')
    course_skill = f'skills/{COURSE_ID}'
    if load(course / course_skill / 'assets/course-plan.json')['totalMinutes'] != 180:
        raise ValueError('Expected the 180-minute course plan')
    camera_entry = load(camera / '.mcp.json')['mcpServers'][CAMERA_ID]
    if camera_entry.get('args') != ['mcp/bridge.mjs']:
        raise ValueError('Expected the complete Camera AI connector')

    entries = {}
    for rel in ['mcp/bridge.mjs', 'mcp/setup.mjs']:
        add_file(entries, camera, rel)
    add_tree(entries, camera, f'skills/{CAMERA_ID}', {'.md', '.json', '.py', '.swift'})
    camera_skill = f'skills/{CAMERA_ID}/SKILL.md'
    skill_reference = (ROOT / 'plugins' / CAMERA_ID / camera_skill).read_text(encoding='utf-8')
    section = '## Studio 拍照和课程基线'
    routing = section + skill_reference.split(section, 1)[1].split('## 能力与操作范围', 1)[0]
    camera_text = entries[camera_skill].decode('utf-8')
    if section not in camera_text:
        camera_text = camera_text.replace('# 相机点亮与 ISP 调优\n\n',
            '# 相机点亮与 ISP 调优\n\n' + routing + '## 能力与操作范围\n\n', 1)
    camera_text = re.sub(r'(?m)^trigger: (?!RDK Camera AI)', 'trigger: RDK Camera AI, 帮我拍张照, 相机拍照, ', camera_text, count=1)
    entries[camera_skill] = camera_text.encode()
    for folder, suffixes in [('mcp', {'.mjs'}), ('web', {'.html', '.css', '.mjs'}), ('device', {'.md', '.py'}),
                             (course_skill, {'.md', '.json'})]:
        add_tree(entries, course, folder, suffixes)
    recovery = f'skills/{CAMERA_ID}/references/imx415-compatibility-and-recovery.md'
    if recovery in entries:
        entries[recovery] = re.sub(
            rb'\[([^\]]+)\]\((?:\.\./)+\.codex/artifacts/x5-imx415-recovery-20261016/hardware-evidence\.json\)',
            lambda match: match[1] + '（源工程历史回执）'.encode(),
            entries[recovery],
        )
    add_file(entries, course, 'README.md')
    entries['WORKSHOP.md'] = entries.pop('README.md')

    entries['plugin.json'] = encoded({
        **camera_manifest, 'version': VERSION, 'defaultEnabled': True,
        'description': '日常相机调试：拍照、点亮、采流诊断、AI 看图调 ISP、读回与恢复。180 分钟视觉 Workshop：三图采集、RoboGO 提交与原 Run 跟踪、ISP、A/B/C 分流、X5 检测和成果留证。',
    })
    entries['.mcp.json'] = encoded({'mcpServers': {
        CAMERA_ID: camera_entry,
        COURSE_ID: load(course / '.mcp.json')['mcpServers'][COURSE_ID] | {
            'requestTimeoutMs': 30000,
            'permissions': {'default': 'deny', 'tools': {
                'vision_course_plan': 'readonly', 'vision_course_stage': 'readonly',
                'vision_course_next': 'readonly', 'vision_course_view': 'readonly', 'vision_course_sync': 'approval',
                'vision_course_camera': 'approval', 'vision_course_camera_status': 'readonly',
            }},
        },
    }})
    entries['README.md'] = f'''# RDK Camera AI {VERSION}

在 Studio 导入包含 `plugin.json` 的 RDK Camera AI 目录，启用扩展。

- **日常相机调试**。在 Studio 助手说「用 RDK Camera AI 帮我点亮相机，读取当前 ISP」。按[相机操作技能](skills/{CAMERA_ID}/SKILL.md)执行。
- **180 分钟视觉 Workshop**。在 Studio 助手说「打开 180 分钟视觉 Workshop，继续我的工位」。通过 `vision_course_view` 打开本机工作台，按[课程操作稿]({course_skill}/references/course-runbook.md)推进。
- **拍照与三张基线**。在工位关联相机实验后打开「照片与三张基线图」，从图卡查看采集、归档与原件下载。也可通过 `vision_course_camera` 发起，使用 `vision_course_camera_status` 查看回执。渲染条件缺失时保留已归档的图并提示如何继续。

实际相机操作沿用相机适配器及原连接配置。课堂工作台保存相机证据，需要时可绑定当前相机实验。训练需本组 RoboGO 授权。提交、查询原 Run、PTQ 和板端验收按课程步骤完成。

相机连接器读取 `~/.config/rdk-camera-workshop/connection.json` 或 `RDK_CAMERA_WORKSHOP_CONFIG` 指定的私有文件。可运行 `node mcp/setup.mjs doctor` 核对连接。

旧版 Studio 若需要显式注册课堂 MCP，可运行 `node mcp/studio-config.mjs`，保留原相机连接。已有单独安装的视觉 Workshop 可接续到同名课程工具。已保存的课程进度可从工作台导入，按需重新附入实拍或回读附件。

工位、RoboGO 与板端归档配置见[课堂工作台配置](WORKSHOP.md)和[设备操作](device/README.md)。
'''.encode()

    entries['SOURCE-MANIFEST.json'] = encoded({
        'version': VERSION, 'cameraBaseVersion': (load(camera / 'SOURCE-MANIFEST.json')['cameraBaseVersion']
            if camera_manifest['version'] == '1.4.1' else camera_manifest['version']), 'courseVersion': course_manifest['version'],
        'files': [{'path': p, 'bytes': len(data), 'sha256': digest(data)} for p, data in sorted(entries.items())],
    })
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f'rdk-camera-ai-{VERSION}.zip'
    with ZipFile(archive, 'x', ZIP_DEFLATED) as package:
        for rel, data in sorted(entries.items()):
            package.writestr(str(PurePosixPath(CAMERA_ID, rel)), data)
    with ZipFile(archive) as package:
        if package.testzip() is not None or any(package.read(f'{CAMERA_ID}/{p}') != data for p, data in entries.items()):
            raise ValueError('Archive verification failed')
    print(json.dumps({'archive': str(archive), 'sha256': digest(archive.read_bytes()), 'files': len(entries)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--camera-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    package(args.camera_source.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve())
