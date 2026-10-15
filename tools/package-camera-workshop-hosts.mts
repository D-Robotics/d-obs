import { mkdir, mkdtemp, readFile, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisionArchive, type VisionArchiveEntry } from '../server/monitoring/vision-workshop-export.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_VERSION = '1.3.0-preview.1';
const name = 'rdk-camera-workshop';
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const json = (data: unknown) => JSON.stringify(data, null, 2) + '\n';
async function files(directory: string, prefix = ''): Promise<VisionArchiveEntry[]> {
  const result: VisionArchiveEntry[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink()) throw new Error('Distribution symlink is not allowed');
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), prefix + item.name + '/'));
    else if (item.isFile()) result.push({ name: prefix + item.name, data: await readFile(path.join(directory, item.name)) });
  }
  return result;
}
async function copyTree(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const entry of await files(from)) {
    if (['plugin.json', '.mcp.json', 'SOURCE-MANIFEST.json'].includes(entry.name)) continue;
    const destination = path.join(to, entry.name); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, entry.data);
  }
}
async function basePackage(output: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'tools/package-camera-workshop.mts'), output], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => { error += bytes; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Base packaging failed: ' + error)));
  });
  const receipt = JSON.parse(await readFile(path.join(output, 'camera-workshop-package.json'), 'utf8'));
  return { directory: path.join(output, receipt.studioDirectory), version: receipt.version as string };
}
export async function buildHostPackages(output: string) {
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(path.join(tmpdir(), 'camera-host-build-'));
  const receipts: unknown[] = [];
  try {
    const base = await basePackage(path.join(scratch, 'base'));
    for (const host of ['qoder', 'workbuddy'] as const) {
      const market = path.join(scratch, host); const plugin = path.join(market, 'plugins', name);
      await copyTree(base.directory, plugin);
      const metadataDir = host === 'qoder' ? '.qoder-plugin' : '.codebuddy-plugin';
      const manifest = {
        name, version: HOST_VERSION, description: '新型号相机资料与适配流程、采流诊断和AI看图ISP调试。通过用户自己的d-obs服务和实际SDK允许字段执行；新Sensor驱动需开发、编译和实机验证。',
        author: { name: 'D-Robotics' }, license: 'Apache-2.0', keywords: ['camera', 'rdk', 'isp', 'bringup'],
        skills: './skills/', mcpServers: './.mcp.json',
      };
      await mkdir(path.join(plugin, metadataDir), { recursive: true });
      await writeFile(path.join(plugin, metadataDir, 'plugin.json'), json(manifest));
      const variable = host === 'qoder' ? '${QODER_PLUGIN_ROOT}' : '${CODEBUDDY_PLUGIN_ROOT}';
      await writeFile(path.join(plugin, '.mcp.json'), json({ mcpServers: { [name]: { type: 'stdio', command: 'node', args: [variable + '/mcp/bridge.mjs'], env: { RDK_CAMERA_WORKSHOP_ONBOARDING: '1' } } } }));
      await copyFile(path.join(root, 'plugins', name, 'mcp/setup.mjs'), path.join(plugin, 'mcp/setup.mjs'));
      await copyFile(path.join(root, 'LICENSE'), path.join(plugin, 'LICENSE'));
      const skillPath = path.join(plugin, 'skills', name, 'SKILL.md');
      const original = await readFile(skillPath, 'utf8');
      const description = /^description: (.+)$/m.exec(original)?.[1];
      if (!description) throw new Error('Skill description missing');
      const body = original.replace(/^---\n[\s\S]*?\n---\n/, '')
        .replace('使用当前运行中发现的 `vision_*` 工具；Studio 原生桥的名称前缀为\n`mcp__rdk-camera-workshop__`。', '使用当前运行中发现的 `vision_*` 工具，以宿主实际工具名称为准。')
        .replace(/2\. 读取真实 `\/capabilities`：[\s\S]*?3\. 只选择/, '2. 调用 `vision_workshop_runtime_status` 读取真实运行能力；`vision_workshop_capabilities` 仅提供操作目录。缺少运行状态工具时报告服务版本缺口，不以目录推断设备在线。\n3. 只选择')
        .replace(/4\. 列出或读取当前身份实验。[\s\S]*?## 自然语言点亮与调优/, '4. 用 typed `vision_experiment_list/get/create` 列出或读取当前身份实验，绑定实际 adapter 后创建实验。缺少工具时报告缺口，不自行构造主机、shell、下载地址、SDK 索引或凭据。\n\n## 自然语言点亮与调优')
        .replace('基线导入可用 typed `vision_tuning_baseline_import` 或目录中的 baseline 操作。', '基线导入使用 typed `vision_tuning_baseline_import`；缺少时报告工具缺口。');
      const onboarding = '\n## Qoder / WorkBuddy 连接\n\n先发现宿主实际暴露的相机工具，不依赖 Studio 的命名前缀。工具缺失或连接失败时，读 [连接与自检](references/host-connection.md)，完成配置和只读自检后再操作设备。当前 stdio 桥只提供已审核 typed 工具，不包含通用 execute；缺少所需 typed 工具时报告服务版本缺口，不绕过工具执行 shell 或自行请求后台。\n\n';
      await writeFile(skillPath, '---\nname: ' + name + '\ndescription: ' + description + '\nmetadata:\n  version: "' + HOST_VERSION + '"\n---\n' + onboarding + body);
      await copyFile(path.join(root, 'plugins', name, 'distribution/host-connection.md'), path.join(plugin, 'skills', name, 'references/host-connection.md'));
      await copyFile(path.join(root, 'plugins', name, 'distribution/HOST-README.md'), path.join(plugin, 'README.md'));
      await writeFile(path.join(plugin, 'DISTRIBUTION.json'), json({ host, version: HOST_VERSION, sourceVersion: base.version, transport: 'stdio', requires: ['Node.js >=22', 'user-managed d-obs camera service', 'private connection configuration'], validation: { hostInstallation: 'unverified', hardware: 'unverified' }, publication: 'not_published' }));
      const entries = await files(plugin);
      const inventory = { version: HOST_VERSION, files: entries.map(entry => ({ path: entry.name, bytes: entry.data.length, sha256: sha(entry.data) })) };
      await writeFile(path.join(plugin, 'SOURCE-MANIFEST.json'), json(inventory));
      const marketManifest = { name: 'rdk-camera-' + host, owner: { name: 'D-Robotics' }, plugins: [{ name, source: './plugins/' + name, version: HOST_VERSION, description: manifest.description, category: 'development', tags: manifest.keywords }] };
      await mkdir(path.join(market, metadataDir), { recursive: true });
      await writeFile(path.join(market, metadataDir, 'marketplace.json'), json(marketManifest));
      await writeFile(path.join(market, 'marketplace.json'), json(marketManifest));
      await copyFile(path.join(root, 'plugins', name, 'distribution/PUBLISHING.md'), path.join(market, 'PUBLISHING.md'));
      const packageFiles = await files(market);
      for (const entry of packageFiles) {
        if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_-]{24,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/d-robotics\//.test(entry.data.toString('utf8'))) throw new Error('Private data in distribution');
      }
      const prefix = name + '-' + host + '-' + HOST_VERSION;
      const marketZip = createVisionArchive(packageFiles); const pluginZip = createVisionArchive(await files(plugin));
      const directory = path.join(output, prefix);
      await mkdir(directory); // Existing releases must be inspected, never silently merged or overwritten.
      for (const entry of packageFiles) { const dest = path.join(directory, entry.name); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, entry.data, { flag: 'wx' }); }
      for (const [kind, data] of [['marketplace', marketZip], ['plugin', pluginZip]] as const) {
        const filename = prefix + '-' + kind + '.zip'; await writeFile(path.join(output, filename), data, { flag: 'wx' });
        receipts.push({ host, kind, filename, sha256: sha(data), bytes: data.length });
      }
    }
    const result = { version: HOST_VERSION, publication: 'not_published', hardware: 'unverified', artifacts: receipts };
    await writeFile(path.join(output, 'host-packages.json'), json(result), { flag: 'wx' }); return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(json(await buildHostPackages(path.resolve(process.argv[2] ?? path.join(root, 'output', 'camera-hosts-' + HOST_VERSION)))));
}
