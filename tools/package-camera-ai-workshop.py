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
VERSION = '1.5.0'


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
    if path.suffix != '.jpg' and re.search(r'/Users/|192\.168\.\d+\.\d+|sk-[A-Za-z0-9_-]{16,}|BEGIN [A-Z ]*PRIVATE KEY', data.decode('utf-8')):
        raise ValueError(f'Private data in package entry: {rel}')
    destination[rel] = data


def add_tree(destination, root, folder, suffixes):
    for path in sorted((root / folder).rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symlink in source tree: {path}')
        if path.is_file() and path.suffix in suffixes and '.test.' not in path.name:
            add_file(destination, root, path.relative_to(root).as_posix())


def update_camera_routing(entries):
    camera_skill = f'skills/{CAMERA_ID}/SKILL.md'
    skill_reference = (ROOT / 'plugins' / CAMERA_ID / camera_skill).read_text(encoding='utf-8')
    start = '## Studio 拍照和课程基线\n'
    end = '## 能力与操作范围\n'
    _, _, reference_tail = skill_reference.partition(start)
    routing, separator, _ = reference_tail.partition(end)
    if not separator:
        raise ValueError('Camera routing instructions are missing')
    camera_text = entries[camera_skill].decode('utf-8')
    if start in camera_text:
        before, _, tail = camera_text.partition(start)
        _, separator, after = tail.partition(end)
        if not separator:
            raise ValueError('Camera routing section is incomplete')
        camera_text = before + start + routing + end + after
    else:
        heading = '# 相机点亮与 ISP 调优\n\n'
        if heading not in camera_text:
            raise ValueError('Camera skill heading is missing')
        camera_text = camera_text.replace(heading, heading + start + routing + end + '\n', 1)
    camera_text = re.sub(r'(?m)^trigger: (?!RDK Camera AI)',
                         'trigger: RDK Camera AI, 帮我拍张照, 相机拍照, ', camera_text, count=1)
    entries[camera_skill] = camera_text.encode()


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
    update_camera_routing(entries)
    for folder, suffixes in [('mcp', {'.mjs'}), ('web', {'.html', '.css', '.mjs'}), ('device', {'.md', '.py'}),
                             (course_skill, {'.md', '.json'})]:
        add_tree(entries, course, folder, suffixes)
    demo = 'web/isp-demo'
    add_tree(entries, course, demo, {'.json', '.jpg'})
    samples = load(course / demo / 'manifest.json')['samples']
    if {item['id'] for item in samples} != {'exposure', 'gain', 'contrast', 'sharpness', 'white-balance'}:
        raise ValueError('Expected one example per instructor parameter')
    for sample in samples:
        for phase in ('before', 'after'):
            asset = sample[phase]
            if asset['image'] != f"{sample['id']}-{phase}.jpg" or digest(entries[f"{demo}/{asset['image']}"]) != asset['imageSha256']:
                raise ValueError('Instructor example image failed verification')
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
                'vision_course_camera': 'approval', 'vision_course_camera_status': 'readonly', 'vision_course_preflight': 'readonly',
                'vision_course_isp': 'approval', 'vision_course_isp_status': 'readonly', 'vision_course_detection_status': 'readonly',
            }},
        },
    }})
    entries['README.md'] = f'''# RDK Camera AI {VERSION}

在 Studio 导入包含 `plugin.json` 的 RDK Camera AI 目录，启用扩展。

- **日常相机调试**。在 Studio 助手说「用 RDK Camera AI 帮我点亮相机，读取当前 ISP」。按[相机操作技能](skills/{CAMERA_ID}/SKILL.md)执行。
- **180 分钟视觉 Workshop**。在 Studio 助手说「打开 180 分钟视觉 Workshop，继续我的工位」。通过 `vision_course_view` 打开本机工作台，按[课程操作稿]({course_skill}/references/course-runbook.md)推进。
- **工位连接预检**。用 `vision_course_preflight` 或工作台的「运行连接预检」核对相机服务、X5 和实时画面。首次接入时从页面的「关联相机实验」绑定正确设备。
- **课堂 ISP**。保存原始版本，完成跟做和自主两轮 Gamma。每轮留下调前与调后实拍、独立参数回读和取舍。升级前关闭旧课堂页。讲师演示可以切换五项已归档的实机对照。
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


LEARNER_RELEASE = '1.5.5'
LEARNER_FILES = (
    'mcp/camera-source.mjs', 'mcp/learner-isp.mjs', 'mcp/server.mjs',
    'mcp/workbench.mjs', 'mcp/workbench-session.mjs',
    'web/app.mjs', 'web/index.html', 'web/isp-panel.mjs', 'web/style.css',
)


def package_learner_release(base, course, out):
    """Extend the verified 1.5.4 release without rebuilding its other workflows."""
    with ZipFile(base) as previous:
        prefix = CAMERA_ID + '/'
        names = previous.namelist()
        if len(set(names)) != len(names) or previous.testzip() is not None:
            raise ValueError('Base archive failed verification')
        manifest_name = prefix + 'SOURCE-MANIFEST.json'
        manifest = json.loads(previous.read(manifest_name))
        files = {entry['path']: entry for entry in manifest['files']}
        if manifest['version'] != '1.5.4' or set(names) != {manifest_name, *(prefix + path for path in files)}:
            raise ValueError('Expected the exact 1.5.4 manifest inventory')
        entries = {path: previous.read(prefix + path) for path in files}
        for path, entry in files.items():
            if len(entries[path]) != entry['bytes'] or digest(entries[path]) != entry['sha256']:
                raise ValueError(f'Base archive entry failed verification: {path}')
    for rel in LEARNER_FILES:
        entries.pop(rel, None)
        add_file(entries, course, rel)
    entry = json.loads(entries['plugin.json'])
    entry['version'] = LEARNER_RELEASE
    entries['plugin.json'] = encoded(entry)
    paragraph = ('学员在同一个课堂工作台里可以读取工位可写项目，单次调一个曝光、增益、'
                 '对比度、锐度或白平衡数值。保留调前调后实拍、独立回读和取舍。真机逐项验收。')
    entries['README.md'] = (entries['README.md'].decode().replace('1.5.4', LEARNER_RELEASE, 1) + '\n' + paragraph + '\n').encode()
    entries['WORKSHOP.md'] = (entries['WORKSHOP.md'].decode() + '\n## 学员单项 ISP 实操\n\n' + paragraph +
        '\n保存期初配置后读取参数。未返回可写范围或仍在自动模式的项目按工位状态锁定。X5 原生锐度需要相机服务支持单字段候选。'
        '保留后先恢复，才能开始另一项。\n').encode()
    entries['SOURCE-MANIFEST.json'] = encoded({
        **manifest, 'version': LEARNER_RELEASE, 'extendsSha256': digest(base.read_bytes()),
        'files': [{'path': path, 'bytes': len(data), 'sha256': digest(data)} for path,data in sorted(entries.items())],
    })
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f'rdk-camera-ai-{LEARNER_RELEASE}.zip'
    with ZipFile(archive, 'x', ZIP_DEFLATED) as package:
        for rel, data in sorted(entries.items()):
            package.writestr(str(PurePosixPath(CAMERA_ID, rel)), data)
    with ZipFile(archive) as package:
        if package.testzip() is not None or any(package.read(prefix + path) != data for path,data in entries.items()):
            raise ValueError('Archive verification failed')
    print(json.dumps({'archive': str(archive), 'sha256': digest(archive.read_bytes()), 'files': len(entries)}))


def package_interaction_release(base, course, out):
    """Build 1.5.6 on the X5-verified 1.5.5 archive."""
    prefix = CAMERA_ID + '/'
    manifest_name = 'SOURCE-MANIFEST.json'
    with ZipFile(base) as archive:
        manifest = json.loads(archive.read(prefix + manifest_name))
        inventory = {entry['path']: entry for entry in manifest['files']}
        names = archive.namelist()
        if (manifest['version'] != '1.5.5' or len(names) != len(inventory) + 1
                or set(names) != {prefix + rel for rel in [*inventory, manifest_name]}
                or archive.testzip() is not None):
            raise ValueError('Expected the verified 1.5.5 package inventory')
        entries = {rel: archive.read(prefix + rel) for rel in inventory}
        for rel, entry in inventory.items():
            if len(entries[rel]) != entry['bytes'] or digest(entries[rel]) != entry['sha256']:
                raise ValueError(f'Base archive entry failed verification: {rel}')
    for rel in ('mcp/server.mjs', 'mcp/workbench.mjs', 'mcp/workbench-session.mjs', 'web/index.html', 'web/app.mjs',
                'web/style.css', 'web/isp-demo.mjs', 'web/isp-panel.mjs', f'skills/{COURSE_ID}/SKILL.md'):
        del entries[rel]
        add_file(entries, course, rel)
    update_camera_routing(entries)
    version = '1.5.6'
    entries['plugin.json'] = encoded({**json.loads(entries['plugin.json']), 'version': version})
    entries['README.md'] = entries['README.md'].decode().replace('1.5.5', version, 1).encode()
    entries['WORKSHOP.md'] += (
        '\n## 打开课堂工作台\n\n'
        '支持入口的 Studio 可从已安装插件卡进入。也可在新对话调用课堂工具后点击返回的链接。'
        '工作台提供继续原工位或独立练习，训练排队或运行时可直接进入 ISP。\n'
    ).encode()
    entries[manifest_name] = encoded({
        **manifest, 'version': version, 'extendsSha256': digest(base.read_bytes()),
        'files': [{'path': rel, 'bytes': len(data), 'sha256': digest(data)}
                  for rel, data in sorted(entries.items())],
    })
    out.mkdir(parents=True, exist_ok=True)
    path = out / f'rdk-camera-ai-{version}.zip'
    with ZipFile(path, 'x', ZIP_DEFLATED) as archive:
        for rel, data in sorted(entries.items()):
            archive.writestr(prefix + rel, data)
    with ZipFile(path) as archive:
        if archive.testzip() is not None or any(archive.read(prefix + rel) != data for rel, data in entries.items()):
            raise ValueError('Archive verification failed')
    print(json.dumps({'archive': str(path), 'sha256': digest(path.read_bytes()), 'files': len(entries)}))


def package_classroom_candidate(base, course, out, event=False):
    """Update the verified Studio classroom package without replacing its connector."""
    prefix = CAMERA_ID + '/'
    inventory_name = 'SOURCE-MANIFEST.json'
    with ZipFile(base) as archive:
        manifest = json.loads(archive.read(prefix + inventory_name))
        inventory = {item['path']: item for item in manifest['files']}
        expected_base = '1.5.9-rc.6' if event else '1.5.9-rc.3'
        if (manifest['version'] != expected_base or len(archive.namelist()) != len(inventory) + 1
                or set(archive.namelist()) != {prefix + rel for rel in [*inventory, inventory_name]}
                or archive.testzip() is not None):
            raise ValueError(f'Expected the verified {expected_base} package')
        entries = {rel: archive.read(prefix + rel) for rel in inventory}
        for rel, item in inventory.items():
            if len(entries[rel]) != item['bytes'] or digest(entries[rel]) != item['sha256']:
                raise ValueError(f'Base archive entry failed verification: {rel}')

    course_files = [
        'device/README.md', 'device/x5-course-detect.py', 'device/x5-station-bridge.py', 'mcp/board-launcher.mjs',
        'mcp/camera-source.mjs', 'mcp/course-evidence.mjs', 'mcp/workbench.mjs', 'mcp/workbench-session.mjs',
    ]
    if event:
        course_files.append('mcp/guide.mjs')
    course_files.extend(path.relative_to(course).as_posix() for path in sorted((course / 'web').iterdir())
                        if path.suffix in ('.mjs', '.html', '.css'))
    for rel in course_files:
        del entries[rel]
        add_file(entries, course, rel)
    server = entries['mcp/server.mjs'].decode()
    entries['mcp/server.mjs'] = server.replace('取得当前原工位的工作台地址', '取得当前工位的工作台地址').replace(
        '原工位和进度自动保留', '工作台可继续上次工位，也可新建空白工位').encode()
    version = '1.5.9-rc.7' if event else '1.5.9-rc.6'
    entries['plugin.json'] = encoded({**json.loads(entries['plugin.json']), 'version': version})
    entries['README.md'] = entries['README.md'].decode().replace(manifest['version'], version).encode()
    entries['WORKSHOP.md'] += (
        '\n## 工位与 Gamma 检测对照\n\n'
        '关闭旧课堂页后升级。课堂工作台提供继续已有工位、新建空白工位或进入 ISP 案例练习。'
        '已提交的训练请登记原 Run。切换工位后，可从课堂页的「当前工位链接」复制浏览器地址。'
        '对照入口详见[设备说明](device/README.md)。本组模型的连续检出按课堂当次实拍验收。\n'
    ).encode()
    if event:
        apply_event_classroom(entries, course)
    entries[inventory_name] = encoded({
        **manifest, 'version': version, 'extendsSha256': digest(base.read_bytes()),
        'files': [{'path': rel, 'bytes': len(data), 'sha256': digest(data)} for rel, data in sorted(entries.items())],
    })
    out.mkdir(parents=True, exist_ok=True)
    path = out / f'rdk-camera-ai-{version}.zip'
    with ZipFile(path, 'x', ZIP_DEFLATED) as archive:
        for rel, data in sorted(entries.items()):
            archive.writestr(prefix + rel, data)
    with ZipFile(path) as archive:
        if archive.testzip() is not None or any(archive.read(prefix + rel) != data for rel, data in entries.items()):
            raise ValueError('Archive verification failed')
    print(json.dumps({'archive': str(path), 'sha256': digest(path.read_bytes()), 'files': len(entries)}))


def apply_event_classroom(entries, course):
    skill = f'skills/{COURSE_ID}'
    source = course / skill / 'assets/ddc-2026-12-06.json'
    plan = load(source)
    entries[f'{skill}/assets/course-plan.json'] = source.read_bytes()
    manifest = json.loads(entries['plugin.json'])
    manifest['description'] = ('RDK Camera AI 相机调试与本场 180 分钟视觉 Workshop。'
                               '开发机原任务、两轮 Gamma、11:45 A/B/C、X5 检测和成果留证。')
    entries['plugin.json'] = encoded(manifest)
    hour, minute = map(int, plan['referenceStart'].split(':'))

    def clock(offset):
        total = hour * 60 + minute + offset
        return f'{total // 60:02}:{total % 60:02}'

    schedule = '\n'.join(f"| {clock(stage['start'])}–{clock(stage['end'])} | {stage['topic']} |"
                         for stage in plan['schedule'])
    deadlines = plan['deadlines']
    entries[f'{skill}/references/course-runbook.md'] = f'''# 12 月 6 日视觉 Pipeline 课堂

| 时间 | 学员任务 |
| --- | --- |
{schedule}

{clock(deadlines['submitStart'])} 按本组连接卡启动一次开发机训练。登记原任务 ID 和实际日志，回 Studio 继续 ISP。
{clock(deadlines['runCheckpoint'])} 助教核对任务进度、产物和预置模型。{clock(deadlines['deployAt'])} 按工位分流。

A 用同一任务的本组 INT8。B 登记预置模型来源与 SHA-256。C 保存演示来源和自己的观察。推理运行、连续检出、
原始 ISP 恢复与停流分别验收。活动候选包需要现场组合签收。

助教可通过绝对路径 `RDK_VISION_COURSE_DEVMACHINE_PROFILE` 配置本机连接卡。
文件内提供 `connection`、`dataset`、`startCommand`、`logPath`、`artifactPath` 五个纯文本字段。
卡片展示操作指引。账户和密码走团队的发放渠道。没有连接卡时学员先做相机和 ISP，到点按产物分流。
已登记的历史 RoboGO Run 可查询原任务，课堂包的 RoboGO 新提交入口已关闭。
'''.encode()
    server = entries['mcp/server.mjs'].decode()
    assert 'const action=steps[args.stageId];' in server
    entries['mcp/server.mjs'] = server.replace('import { guideCourse,', 'import { classroomStep, guideCourse,').replace(
        'const action=steps[args.stageId];', 'const action=classroomStep(plan,args.stageId);').replace(
        'const nextStep=guideCourse(plan,current.resume).nextStep;',
        'const {nextStep,routing}=guideCourse(plan,current.resume);').replace(
        'openInStudio:{url,target:\'local\'},nextStep,', 'openInStudio:{url,target:\'local\'},nextStep,routing,').replace(
        '仅打开课堂时无需连接设备或启动采集。',
        '只打开课堂时无需额外诊断或启动采集。课堂 A 为本组 INT8，B 为预置 INT8，C 为观看演示。分流使用此处 routing；停流回执不能当作未接相机。').encode()
    instructions = entries[f'{skill}/SKILL.md'].decode()
    instructions = instructions.replace('RoboGO 异步训练','直连开发机训练').replace(
        '开场第 35–45 分钟采三种基线，第 45–50 分钟按组提交 RoboGO。收到已有 Run ID 后只查询原 Run。茶歇由助教核对，第 110 分钟个人盲选，第 120 分钟助教预检，第 130 分钟按实际产物与设备状态做 A/B/C 选择。',
        f'按课程配置推进。{clock(deadlines["submitStart"])} 按本组连接卡启动一次训练，已有任务只查原 ID。'
        f'{clock(deadlines["runCheckpoint"])} 助教预查，{clock(deadlines["deployAt"])} 按回执分流。'
        'A 为本组 INT8，B 为预置 INT8，C 为观看演示。仅打开课堂时用课堂工具的现有状态给第一步。')
    entries[f'{skill}/SKILL.md'] = instructions.encode()
    entries['README.md'] += '\n该候选包使用 12 月 6 日课堂配置。\n'.encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument('--camera-source', type=Path)
    sources.add_argument('--base-release', type=Path)
    sources.add_argument('--interaction-base', type=Path)
    sources.add_argument('--classroom-base', type=Path)
    sources.add_argument('--event-base', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.event_base:
        package_classroom_candidate(args.event_base.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve(), event=True)
    elif args.classroom_base:
        package_classroom_candidate(args.classroom_base.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve())
    elif args.interaction_base:
        package_interaction_release(args.interaction_base.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve())
    elif args.base_release:
        package_learner_release(args.base_release.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve())
    else:
        package(args.camera_source.resolve(), ROOT / 'plugins' / COURSE_ID, args.output.resolve())
