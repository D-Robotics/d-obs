# X5 / IMX415 兼容性与失败恢复

用于版本选择、点亮前提、ISP 调优和失败后的下一步判断。来源核查截至 2026-10-15；
下面的实机结果属于已保存的本轮历史证据，不是实时设备状态，也不是可自动重放的操作清单。
任务只要求查资料时保持只读；安装插件或读取文档不授权升级、烧录、重启或调参。

## 镜像、ROS 与 SDK 分别核对

用户提供的七页《RDK X5 驱动 IMX415 摄像头教程》PDF，SHA-256 为
`ffb3b559879673f6add256d51bcc7f43eeeace54d122c695c3b7bbdcbededd9c`。
结合《IMX415_主板兼容性说明（必看）.xlsx》的截图，按以下边界使用：

| 来源 | 已确认的条件 | 决策边界 |
| --- | --- | --- |
| PDF 第1、3、4页 | 厂商 ROS 直接支持路线要求 RDK X5 镜像 ≥3.5.0、TROS Humble，`tros-humble-mipi-cam` 和 `tros-humble-hobot-stereonet` 均 ≥2.4.1 | 这是该厂商指南的组合条件，不证明所有旧版原生采集都不可能出图，也不证明当前安装已满足条件。 |
| PDF 第4页第4节 | 旧版 **ROS 镜像**有专属的依赖、系统及 miniboot 升级说明 | 先核对镜像来源与适用说明；不将步骤推广到任意旧镜像，不自动执行更新。 |
| 兼容性截图 | X5 默认 I²C 地址 `0x1a`；≥3.5.0 标为可直接使用；两个 <3.5.0 分支分别标为厂商提供适配、无法驱动且不支持命令升级 | 截图可见单元格没有标出两个旧分支各自的镜像类别。不能擅自分别贴上“ROS”或“大模型镜像”标签。 |
| PDF 第3、5页 | 指南复用 TROS/BSP 的 `mipi_cam`，并通过 `hobot_codec`、`websocket` 展示；没有提供独立 Linux 内核模块 | 不是一个通用于任意 BSP 的驱动安装包；不能套用截图中树莓派的 `.ko`/设备树地址修改路线。 |

只知道系统为 3.1.1 时，只能确认低于上述直接支持门槛；是否可按旧 ROS 说明升级仍需镜像来源证据。
RDKOS 3.5.0 与 SDK 文档 2.0.0 是不同版本标识，不能相互推导。
升级后也须重新核对实际 headers、共享库、VP 布局和运行时 ABI，而不是把升级当作兼容验收。

## 接口、模式与“检测到”的含义

官方 X5 板卡资料给出的接口映射如下。用相对以太网口的位置和板卡标识定位，
“上方接口”会随板卡摆放改变，不能单独决定端口。

| 板端位置 | CSI host | I²C 总线 | reset GPIO |
| --- | --- | --- | --- |
| 靠近以太网口 | 0 | 6 | 353 |
| 远离以太网口 | 2 | 4 | 351 |

这些映射来自官方板卡资料，不来自厂商 PDF；PDF 第2页只展示模组排线照片。
核对 22pin 同向排线、触点方向和锁扣；更换排线或接口前先断电。
不要把 SDK EVB 的 GPIO/总线表套到 RDK X5。

官方 VP 提供 IMX415 的 3840×2160、linear RAW10、30 fps、`0x1a` 的 2-lane 与 4-lane profile。
这证明存在两个软件配置，不证明当前模组、排线及端口都支持两种模式，也不证明实际帧率达标。
厂商 PDF 和截图没有给出 lane 或原生分辨率，必须另核对实物及所选官方配置。
CSI host 编号只用于 VIN 的 `mipi_rx`；profile 的 `rx_attr.phy` 是 DPHY/CPHY 类型，不能写成 host 2。

旧版 `libsrcampy.open_cam` 的 `video_index` 选择板卡配置中的 camera 条目，不直接等于 host 编号。
其 `raw_height/raw_width` 是原生 Sensor 模式筛选条件，输出缩放尺寸是另一组参数；
用 1920×1080 筛选原生 3840×2160 的 IMX415 可能排除已检测到的模式。
Python 接口没有显式 Sensor 名称/lane 参数；需要固定模式时使用匹配 SDK 的官方配置与受控 adapter，
不猜 profile 索引，也不因自动检测列出两种模式就宣称两者均通过。

I²C ACK 只证明某地址有响应；匹配 chip ID 也不证明 CSI 有数据、ISP 有输出或帧可用。
`No camera sensor found` 是当次探测/过滤失败结果，不能直接等同于相机未连接或损坏。
探测读失败被显示为 `00` 时，不能把它当作真实 Sensor ID。
`mipi mclk is not configed` 表示未配置 SoC 输出 MCLK，不是实际时钟测量；
外部晶振模组可能正常采集，不能只据该提示改设备树或认定致命。

## 光学条件与画质判断

模组资料标明手动对焦。存在 AF/AFM 软件 API 不等于这颗模组有可控对焦马达；
没有已实现的软件原子能力时，由实际操作员调整焦点并确认目标距离，再采新帧比较。
模糊可能与焦点、距离、运动、曝光或 ISP 有关，不能只看一张图就确诊物理失焦。
数字锐化不能恢复已经丢失的细节。

PDF 第3页说明 IR-CUT OFF 用于常规可见光色彩，ON 允许红外且可能偏红。
记录实际开关状态、场景照明与目标；不要用白平衡补偿未经确认的 IR-CUT 状态。
比较同尺寸、同颜色转换的新帧中固定的文字、物体边缘和纹理，明确人物移动等局限。
同时检查可辨细节、噪声、光晕、曝光和颜色；全局方差、Laplacian、颗粒增加或单纯变暗都不能证明清晰度改善。

## 本轮历史证据与停止条件

| 保存证据 | 可以说明什么 | 不能说明什么 |
| --- | --- | --- |
| 2026-10-14 官方 `libsrcampy` 曾连续读取80帧并保存可辨识现场图像；Sensor 模式为3840×2160，输出1280×720 | 当时官方短采集链路曾可用 | 不证明当前仍出图、稳定实际帧率、4-lane、平台原生 v2、Bayer RAW、ISP 恢复或画质通过。 |
| 2026-10-14 19:01，单次恢复官方相机服务后完成90次成功取图并保存现场图像，随后正常关闭 | 当时官方链路有一次故障恢复证据 | 未独立验证每帧 ID/时间戳；不证明参数恢复、临时桥或热切换稳定性，也不授权平台自动重启服务。 |
| 已核对的3.1.1环境使用旧 multimedia/dev SDK；缺少本原生 v2 所需的新版 CPROC、EE、2DNR/3DNR typed 接口，CPROC 使用旧 API | 此 SDK 不能仅凭官方出图就视为兼容当前 v2 adapter | 不能伪造类型、替代 setter 或将另一版本 SDK 的字段直接写入；临时诊断桥不属于插件适配器。 |
| 2026-10-15 新 boot 后的保存日志出现 MIPI PHY stop-state 等待失败、开流 `-36`，并有关闭 `-37` | 当次流生命周期失败，不能继续当作已点亮或已恢复 | 数字报错本身未证明版本、lane、时钟或硬件损坏中的唯一根因；PDF 没有解释这些错误码。 |
| 2026-10-15 未加载临时 preload 桥的官方程序同样失败；2-lane、4-lane 均0帧；当日重启一次相机服务仍未恢复 | 失败不只发生在加载临时桥的路径；当天这次重启没有恢复证据，与前一天单次成功分别记录 | 不证明桥绝无影响、两种 lane 均不受支持、设备永久故障或需要反复重启；也不能用前一天成功覆盖当天失败。 |

失败发生后停止 ISP 优化，保留原始日志、版本、profile、开关状态与帧计数；
先解决受支持的镜像/驱动组合和稳定开流，再评价光学条件及 ISP。
更低系统版本是排查线索，不能宣称已证实为 `-36` 的唯一原因。
没有新的原因证据或明确受控方案时，不重复重放失败 scene，不自动重启设备或循环切换 lane。

## typed controls 与恢复门禁

1. 先读取当前能力和只读 probe，分别识别 SDK 缺口、待开流与实际取帧失败。
   X5 typed controls/getter 依赖已成功创建的真实 pipeline；开流失败后不硬试 getter/setter，
   不以临时桥或热切 scene 绕过 SDK 不兼容。
2. 成功开流并归档本次有效新帧后，再用真实 getter 保存原始配置、版本与哈希。
   只有支持、可写且 active 的字段进入调参；实际运行时模式与范围不能用配置声明代替。
3. 写后用独立 getter 核对实际值，并取得有效新帧及对应 tuningHash。
   场景切换函数返回成功、请求值回显或旧队列图像都不能证明 ISP 已应用或流仍可用。
4. 写入异常、取帧失败或清理不完整时，保留 `cleanupRequired:true`、
   `writeOutcome:'unconfirmed'` 或相应恢复错误；不能因重启 daemon、Run completed 或配置哈希匹配就清除。
   新 AI Run 必须被真实 recovery fence 阻止，先显式停止/清理，再恢复、getter 回读和取得新帧。
   失败恢复只尝试已授权的受控路径；不在 catch 中再次自动恢复或重复重放失败 scene。
5. 分开报告配置恢复与流验证。`final.restored` 只确认配置；
   `streamVerification:'verified'` 需要恢复后的新帧、有效归档及匹配哈希，
   `'failed'` 阻止新调试，历史缺少此字段按 `'unverified'` 展示，不能伪装已验证或一概阻断所有历史实验。

readiness 的保存观察不是实时探测。无 AI 历史也可能有清理/写入未确认的 probe 记录；
提示用户重新检查连接以取得当前 probe，并按实际清理/恢复结果更新状态，不能永久沿用旧失败记录。
普通 `streaming:false` 仅表示停止，不单独判成未恢复。
报告 SDK 不兼容、取帧失败、清理待完成或恢复待确认的具体原因和下一步，不输出“恢复成功”占位文本。

## 2026-10-15 后续升级与实机复验

以下追加旧案例之后的观察；不覆盖前述失败，也不表示当前设备永远在线。
升级后的实测组合为 RDKOS 3.5.0、multimedia 3.0.5、multimedia-dev 3.0.4、
spdev 3.0.9。原生 ABI 2 用实际 headers、库和 VP profile 编译/链接/加载，
backend/modules/replay 隔离测试通过；这些是本组合的软件证据，不自动延伸到其他 SDK。

后续原接口恢复控制应答并取得 3840×2160 NV12 新帧。2-lane 的取帧 -43 与同次
MIPI CRC/PHY fatal、SIF 尺寸错误同时出现；这是关联，不是所有 -43 的唯一根因。
当前安装 HBN 头文件中 43 为 NODE_DEQUE_ERROR，返回阶段仍须实际诊断。
attach 的 -207 在对应相机头文件中为 HB_CAM_I2C_WRITE_FAIL；
它属于控制访问失败，不能与旧 -36/-37 或取帧 -43 合并解释。

使用该 SDK 完整官方 4-lane profile、CSI host2 后，有一次 90 秒/299 次成功取图，
没有新增 CRC/PHY 错误，后续一次预览取得 407 张图且 0 次恢复、正常关闭。
这是有界证据。另一次预览前约 78 秒可用、后来在 543 帧附近失败；
0 setter 的只读预览也报过 -43。不能据此承诺永久稳定或将 profile 标注的 30fps 当实测率。
帧号/SDK 时间/主机时间的来源和分组需保存；帧率与参考时钟不符先排查，不凭比例猜定晶振。
控制访问与开流均失败时，ISP 调参停止；完整断电后重新确认 chip/profile/新帧，
才可记录一次受控恢复，不据此默认反复断电或重启服务。

公开 getter 曾有 hdr_exposure/autofocus/rgbir 返回 -35；本安装版本中为 GET_CONTROL_FAIL，
不是 NOT_SUPPORT。module_control.version 则在 SDK 成功返回时出现越界漂移，
必须保留语义异常证据，不能归零或伪造非零 SDK 错误。
配置 scope 从可读模块进一步收窄时参与 layoutHash，原始库归档与公开模块范围分开。
实际完成核心 exposure/awb/cproc scope 的 CPROC 写入/回读/新帧/恢复，
不代表 AE/AWB 可写或 23/34 个模块完整恢复已通过。

批量应用曾返回 -5，后续逐模块定位到 color_process 路径；cproc 自身的独立 mode 和
manual 字段回读正确。不能由批量错误断言 CPROC 被固件拒绝；
SDK 错误与 native 归一化回读比较返回 -EIO 分阶段记录。
官方库 CP_1_2.state=2 对应 AUTO，不表示模块关闭；
CPROC mode getter 不能机械套用 AE/AWB 模式资格限制。
库中 BT.709 limited 声明仍不能替代运行时输出色彩资格。

本轮 CPROC 中性参考/小幅对比度以及 NR2D AUTO 单叶子实验，已有实际写入、
独立回读、新帧和原始状态恢复证据，但没有可靠文字细节或噪点改善。
EE 小幅实验只取得一张候选后遇到 -43，并有构图变化，不能认可画质。
故障时的恢复与后续显式恢复各自看真实回执，不以一张候选或相同 hash 宣布完整恢复。
顶灯 flare、剪切、偏色与细字偏软仍需按现场目标检查；
这些实验值不作为插件默认调参序列、通用范围或推荐 tuning。

## 2026-10-15 晚间的时序候选与回滚经验

同板后续用 VIN/SIF 独立测得约 46.46fps、FS 间隔 21/22ms，原配置却声明 30fps；
停流保留 handle 的 SDK 读回确认 VMAX2250、HMAX1066 和 24MHz/720Mbps 表。
不能只凭参考时钟字段或比例把模组实装 INCK 写成已测事实。

私有完整时序候选曾取得主机约 29.993fps、SDK 30.000fps 和 33/34ms FS：
采用 upstream 37.125MHz/891Mbps 组、RX aggregate3564、HMAX1100/VMAX2250，
保留窗口/保留位，standby 配置并在 operating 后等待 100ms。
但后续启动仍出现 0 帧、get -43、PHY fatal0x10c、boundary/sequence 和 IPI reset。
它是被实机验证并发现稳定性缺口的实验候选，不能注册为通用推荐 profile、自动修复或默认值。
输入时序成立、连续采集成立和 ISP 画质改善必须分别验收。

时序恢复另设 ledger：保存原 Sensor 字节和 RX profile；确认旧 native 已关闭后，
fresh 原后端，核对原寄存器、RX2880和严格递增的新帧号/时间戳，再确认完整恢复。
ISP module hash 恢复不覆盖 Sensor/RX；sensor 字节恢复也不代表 RX 已恢复。
正常退出及一次真实 get -43 失败的独立恢复均有实测证据，失败仍不得无限自动重开。

contrast1.2 和校正时序下 EE48→52 都没有可靠文字改善，已恢复；
后者有 275 次成功 SDK 取图、约57.93秒时间戳跨度及9张前后/恢复图。
前者的首张候选和首张恢复可见过渡，故 getter hash+新 frame_id 不能单独证明参数对像素生效。
按实际缓冲深度排除在途帧、比较多帧稳定结果；本次 discard12 不是所有 SDK 的通用保证。
不要把这些受控工程实验标记成后台模型自主 Run、标定完成或最佳 tuning。

候选参数来源：[固定版本 upstream IMX415](https://github.com/torvalds/linux/blob/0fcb05b72344f40806cbe810de8872f1698bf053/drivers/media/i2c/imx415.c)。
公开代码支持这些时钟组合，不等于确认亚博模组的实装晶振或保证其 X5 适配。

再以 settle=0 的 SDK 默认路径作单变量接收侧试验，67次取图及原profile完整恢复通过；
后续约80秒预览窗口测得 VIN2486帧/30.003fps，PHY/CRC/边界/顺序错误计数为0。
这仍是私有临时候选，不自动晋升为长期稳定、重开稳定或冷启动合格配置。
官方 FAQ 对0的自动计算描述，应与本版 PHY 实现区分：
[公开源码](https://github.com/D-Robotics/x5-drv-camsys/blob/22c7c2e870622fe779d832ef1753b27191772cdd/mipi/hobot_mipi_phy_ops.c#L569)
的0分支保留/读取默认 settle，非0才写 override，HS范围另按aggregate/lane选择。
未绑定板上kernel源码和实值时，不把它表述成891Mbps专用自动标定或据此给通用手动settle。


## 2026-10-15 文字场景复验：参数回读与像素稳态分别判断

默认settle=0候选的一次600秒上限预览已结束：1991张预览帧、0次ISP写入、closed=true，
随后fresh原Sensor/RX完整恢复并独立取得3帧。600秒是请求上限，回执不提供独立实测总时长；
预览取图数不代替VIN输入计数或连续30fps验收，也不证明冷启动、多次重开或长期稳定。

固定4K文字场景先保存原始3张且0次ISP setter，再分别测试EE AUTO第一槽第一系数48→56、
NR2D AUTO sigma第1分量2.0→1.6；原始/候选/恢复各3张，两轮均无可靠文字可读性改善。
各轮2次setter含恢复，有独立回读和恢复后新帧，ISP journal及Sensor/RX完整恢复分别确认，正常关闭。
这些是可核对的受控实验，不是默认tuning参数、硬件安全范围或模型自主Run资格。

首轮NR的前两张恢复图仍见过渡，不能因discard12、配置hash和新frame_id就判像素已稳定。
另一次同参数复验在每次capture前drain约2.028–2.130秒、实际8–23帧，共9张；
ISP和Sensor/RX恢复已确认，独立视觉审查仍无可靠文字改善；恢复3张颗粒与清晰度一致，
未再见上一组明显平滑过渡。保留EE48和NR sigma第1分量2.0，不晋升best。
保留每次实际等待和drain计数，比较同场景的多张图；2秒仅是本次排队缓解，
未形成通用队列fence或像素收敛门槛，不把恢复后的过渡帧直接用作画质结论。

AUTO第一槽被改写、独立getter回读一致，不证明该槽当前active；analog gain=1也不证明total gain=1
或AUTO插值区间。`sigma_scale[0][0]` 的2.0→1.6只表示首个sigma分量变化，不能表述为总降噪强度降低20%。
4K文字左糊右清是持续观察，对焦、景深和目标平面倾斜仍须受控物理对照，不能据此诊断硬件损坏。
归档收据SHA-256、每阶段配置、SDK帧身份与恢复结果；共享知识不带原图、私有路径或连接凭据。


## 2026-10-15 远距离文字对照：保留 EE48

焦环由用户确认未动，物理调整预览0次ISP写入。拉远、卡面近似平行后，在原EE48下细笔画更可分，
左糊右清差距减轻；但物距、姿态和视场同时变化，只支持待进一步核实的光学几何影响，
不能给出定量锐度收益、唯一原因或损坏诊断。

远景EE AUTO首系数48→64（系数+33.33%），仅在本次operator factorMax=1.34及私有preset envelope内试验；
这不是官方推荐值或硬件范围。候选/恢复计划各只含一个`auto_attr.sharp_gain_0_0`字段。
原始/候选/恢复各3张4K图，9张metadata的exposure=21592.59282052517us、reported gain=1一致；
同一文字ROI无明显组内过渡。独立视觉审查无可靠新增笔画或可读内容，移动背景人员不作ROI，
保留EE48，不晋升best。ISP配置、新帧、journal及Sensor/RX完整恢复分别确认，正常关闭。

安装SDK头的sizeof/offsetof仅用于离线解析已有baseline raw，未获取当前硬件状态：
归档AE again/dgain/ispgain均1；EE autoLevel10、gain轴1/2/4/8/16/32/64/96/128/255，
sharpGain前两行[48,48]。它们仍是配置值，不能证明effective EE、AUTO活动槽或插值结果。
记录原始收据/解析日志哈希及证据边界；仍运行的局部预览不记closed或完成。


## 2026-10-15 EE raw current 往返观测

另一次仅作配置观测的probe，将同一EE AUTO首系数48→64→48，实际候选/恢复计划各仅一个叶子；
9次raw SDK getter按原始/候选/恢复各3次，manual/current sharpGainUp为47→63→47，down恒47，
模式AUTO未变，AE again/dgain/ispgain均1。它增强参数采用证据，但仍没有帧applied序号、活动AUTO槽
或插值权重保证，不能标记逐帧应用认证，也不推导表值与current恒差1的通用公式。
该probe没有归档图像；恢复后两次AE曝光发生变化，不作画质ABA，也不替代此前远景9张PNG的质量评价。
ISP scoped恢复、native关闭及独立Sensor/RX完整恢复均通过；默认仍保留EE48/NR sigma首分量2.0。

[官方SDK §5.7.4](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/en/multimedia_development/5-ISP_Tune_API_zh_CN.html#interface-description)
说明tuning JSON state2的AUTO可读取current与auto；
[EE头文件](https://github.com/D-Robotics/x5-hobot-multimedia-dev/blob/main/usr/include/isp_feature/isp_ee.h)
将manual结构说明为current配置。normalizer清零AUTO manual分支是可恢复配置hash的稳定化，不能把0当模块关闭。
分别保留raw current诊断和可恢复config hash；软件快照不能替代像素生效或最佳画质验收。
最终4K预览19:55:47以600秒上限启动，最近报告仍运行；没有退出回执前不记closed。

## USB 网络闪连单独诊断

USB 枚举、ADB、USB 网卡和 IP 连通是不同证据。ADB 可用不代表已建立网络；
看到 AX88179B 仅证明出现相应 USB 以太网设备，不能据此认定已识别 RDK 板卡。
ARP 缓存可能是旧记录，也不能证明板卡当前枚举、在线或 SSH 可用。

出现闪连时先保存 USB 描述符/插拔事件，再核对网卡驱动、链路、实际地址/路由和当前对端响应；
不要把网络断连直接归因于相机、ISP 或 MIPI 错误，也不自动改网络、重置板卡或重复启动相机。
共享知识只保留诊断方法和脱敏结果，不携带内部地址、凭据或本机路径。

## 可复核的公开资料

- [RDK X5 硬件介绍](https://developer.d-robotics.cc/rdk_x_doc/Quick_start/hardware_introduction/rdk_x5)：端口与排线要求；按实际板卡修订核对。
- [X5 VIN 示例](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/samples/sample_vin.html)：IMX415 官方模式与采集链路；文档 SDK 版本不代替板端版本。
- [Sensor bringup](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/isp_tuning_guide/Camera_sensor_bringup.html)：硬件、配置与初始化排查。
- [ISP tuning](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/isp_tuning_guide/isp_tuning/isp_tuning.html)：匹配 SDK 的工具和调试前提，不代表插件已完成全部实机能力。
