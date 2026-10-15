# Workshop 2 候选与交付

复用 [现场手册](../../../../docs/vision-workshop-workshop2.md)、`vision-workshop-delivery.ts` 和现有 Studio 交付面板。以下流程已通过隔离软件测试；目标板 SDK 链接、真实加载与画质须另取实机证据。历史采图与本轮候选验收分别查证，不把旧的“尚未接好”延续为当前设备事实。

1. 明确选定交付目标。普通候选、AI best、厂商效果库各有服务器生成的标识。保存观察记录不得暗中改选目标；丢失已选目标不能退回其他候选。
2. 为实际场景保存验收计划，写清光照、必需项目、单位、方法和阈值。新计划有新版本 ID，旧记录不能自动通过新计划。数值结果由服务器比较；视觉结论须有操作员文字依据，缺项保持 incomplete。
3. 记录本实验的实际图像。读取文件再次校验字节哈希，至少一张图须匹配选定参数版本与场景；跨账号、跨实验、未知图像或破损字节均拒绝。测量报告与操作员结论保存来源，不能升级成独立认证。
4. 原生 SDK 快照属于会话恢复引用。生成厂商候选需私有 `effectLibraryExportBinding` 绑定 SDK、模式、原模板、基线模块及字段映射；映射必须覆盖全部实际变化并验证范围和数组形状。缺绑定或遗漏字段时阻断生成。
5. 导出后校验并归档真实 JSON 字节，账本仅保存元数据。下载和 ZIP 再次读取、校验哈希；重复归档也重读原文件。完整实验包包含 `delivery.json`、精确 vendor JSON 与手册。
6. 加载厂商候选显式传 `artifactRole: vendor_effect_library_candidate`。只有对应私有生成回执、SDK 独立 getter、真实新帧和匹配参数身份才能形成加载记录。旧协议加载相同字节不能自动取得该资格；新 session 资格还须有实际 native pipeline open 边界。
7. 写入或恢复失败后保留栅栏。成功查询/probe 不能清除先前未确认恢复；恢复原始版本须有匹配原始 hash 的实际回读与新帧。交付页只汇总已存证据，不执行探测或硬件操作。
8. 下载手册时从实际计划和记录重算结果，保留不完整项、原始版本、候选/图像哈希和恢复状态。`workshopReady` 的范围是项目记录链，不代表独立质量认证。

回归运行 `vision-workshop-delivery.test.ts`、`vision-workshop-delivery-reload.test.ts`、`vision-workshop-export.test.ts` 与 Python ISP/camera/HTTP 测试。发布正式候选后，还要在实际 Node 下测试编译 JS 和成对账号桥；源码测试不能替代部署产物测试。

Studio 验证包含账号切换后正文读取的晚到响应、精确 JSON/Markdown 下载及中英窄屏。折叠 `details` 后 Tab 循环只计算实际可见控件，嵌套相机窗口的 Esc 只关闭相机并归还焦点。通用 DialogShell 的隐藏末控件不能作为最后一个可聚焦元素。
