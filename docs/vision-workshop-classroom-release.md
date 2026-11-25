# 视觉 Pipeline 课堂发布

课堂 HTML 和 Studio 课堂插件使用现有视觉工作台的登录权限。可从以下入口打开与下载。课件首页提供同一份课堂插件 ZIP。

- 讲师课件：`/dobs/api/ops/observability/vision-workshop/classroom`
- 课堂插件 ZIP：`/dobs/api/ops/observability/vision-workshop/classroom/plugin`
- 正式插件包：`/dobs/api/ops/observability/vision-workshop/plugin-packages/studio/download`

课堂 ZIP 为 `1.5.9-rc.7`，正式下载为 `1.5.8`。两个入口独立取文件。界面及工作坊流程用课程示例图做两轮 Gamma，板端采用固定检测图，设备验证记录与课件验收分别保存。

`plugins/vision-workshop-packages/classroom-manifest.json` 绑定两个课堂资产的文件大小与 SHA-256。讲师 HTML 嵌入受众专用的现场资料和二维码，通过现有登录入口发布，源仓库保存课件生成脚本及制品校验值。部署时在对应的发布目录放置 `plugins/vision-workshop-packages/classroom.html`。

更新时先保留已验收的输入课件、参考 PDF、工作坊素材和插件 ZIP。将素材放回生成脚本引用的相对路径后，用：

```bash
python3 tools/sync-vision-workshop-classroom.py \
  BASE.html plugins/vision-workshop-packages/classroom.zip classroom.html \
  --closing-reference closing-reference.pdf
```

核对嵌入的 ZIP 与独立下载逐字节一致。作品文件变更后同步更新校验清单。生产回归同时检查匿名请求被拒绝、登录身份可读取、课件和 ZIP 字节完整。
