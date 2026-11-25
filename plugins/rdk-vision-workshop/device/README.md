# X5 三类课程模型实测

`x5-course-detect.py` 使用现有 X5 Camera SDK 适配器和 RDK Model Zoo 的 Ultralytics YOLO Detect。原生 X5 验收需要与相机板卡匹配的私有配置、已有的适配器模块、Model Zoo 检测 wrapper 与 Python 工具、合格的 ISP 候选和课程静态图。

先在 Studio 逐工位执行 probe，并检查实验没有进行中的调试或待恢复写入。独占诊断使用与原 daemon 相同的用户与私有配置。开始前停止同一 systemd 相机服务，确认没有第二个采集进程。退出后检查原始 ISP 回读及停流，再启动原服务。

```sh
python3 device/x5-course-detect.py \
  --profile model-profile.json \
  --model course-yolov8s_bayese_640x640_nv12.bin \
  --effect selected-effect.json --effect-sha256 <archived-sha256> \
  --static-image course-static.jpg --model-zoo <pinned-model-zoo-wrapper-directory> \
  --camera-module <board-installed-camera-module> --camera-config <board-private-config> \
  --output <new-private-evidence-directory> --seconds 30
```

Model Zoo 目录包含 `ultralytics_yolo_det.py` 及兼容的 `utils/py_utils`。模型 profile 按课堂模型绑定 `.bin` 的 SHA-256、六个输出名与形状、640×640 NV12 和 park / qrcode / obstacle 类别顺序。所有复验依据既有设备身份和候选实际资格。

验收时检查静态 BPU 结果、带框实时 JPEG 序列、单调 SDK 时间戳、模型及实际 ISP 哈希、采集处理 FPS、前向中位耗时和原始恢复结果。画面是否实时呈现还需要从实际预览窗口核对。未确认当前设备状态时，保留私有恢复日志供原相机流程处理。

课堂做一次 Gamma 对照时，改用 `--gamma-toolkit <Camera Workshop 的 x5_gamma_tuning_candidate.py 和 x5_gamma_band_candidate.py 所在目录>`，保存原始、候选、恢复三张图。已加载配置且只核对推理时使用 `--current-isp`。Gamma 试验使用单独的恢复账本和当前实际相机状态。结束后检查运行目录的 `receipt.json`、三份 ISP 回读以及图片。

将同一运行目录完整同步到本机私有工位目录，把绝对路径配置为课程 MCP 的 `RDK_VISION_COURSE_BOARD_ARCHIVE`。导入工作台前仍要核对模型 SHA-256 与本组产物一致。运行成功、检测框数量、学员认为是否检出目标在页面中分别记录。

## Studio 一键检测的工位配置

助教在 Studio 所在电脑上配置一个可信的启动程序。配置保存为当前用户可写的私有 JSON，`RDK_VISION_COURSE_BOARD_LAUNCHER` 指向其绝对路径。工位已打开时，先导出进度，再重开相同工位加载配置。

```json
{
  "archiveRoot": "/absolute/path/to/private/board-archives",
  "experimentId": "<本工位已关联的相机实验 UUID>",
  "profiles": {
    "A": {
      "executable": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/x5-station-bridge.py", "client", "--config", "/absolute/path/to/own-client.json"],
      "modelSha256": "<本组 X5 BIN 的 64 位十六进制 SHA-256>",
      "supportsApprovedIsp": true,
      "supportsIspComparison": true
    },
    "B": {
      "executable": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/x5-station-bridge.py", "client", "--config", "/absolute/path/to/preset-client.json"],
      "modelSha256": "<预置 X5 BIN 的 64 位十六进制 SHA-256>"
    }
  }
}
```

运行目录须提前存在。Windows 使用本机可执行文件和目录的绝对路径。每个路径绑定一个实际模型，B 可省略。启动程序只接收固定参数，由助教配置同一块板卡的可信连接、Model Zoo、课程样张和适配器。启动时提供以下环境变量。

仓库的 `x5-station-bridge.py` 提供了 SSH 启动器。将它与检测 runner 放到板上固定目录。电脑的 `*-client.json` 填 `sshHost`（已配置且校验过主机密钥的 OpenSSH 别名）、`boardBridge`（板上的启动器绝对路径）和 `boardConfig`（板端配置绝对路径）。可用 `sshExecutable` 指定本机的 OpenSSH、`sshConfig` 指定本机私有的 OpenSSH 配置。该别名需要已有的非交互授权。

板端配置填 `model`、`profile`、`staticImage`、`modelZoo`、`cameraModule`、`cameraConfig`、`runner` 和 `runRoot` 的绝对路径，再填实际的 `cameraService`、`cameraUser`、可选的 `seconds`（1–60）。`runRoot` 由相机用户持有并只向该用户开放；服务管理由已授权的 SSH 账户执行。

- `RDK_COURSE_RUN_ID` 为本轮 UUID，传给板端的 `--run-id`。
- `RDK_COURSE_MODEL_SHA256` 为已选模型的 SHA-256。板端再次根据实际 BIN 校验。
- `RDK_COURSE_RUN_ARCHIVE` 为本机本轮目录。同步板端的同名实拍、结果图及 ISP 回读之后，原子替换本机的 `receipt.json`。实时同步时先同步对应 JPEG。进程结束前完成同步和原相机服务清理。标准输出及错误写入本机本轮的 `runner.log`。
- `RDK_COURSE_APPROVED_ISP` 为空时用 `--current-isp`。该值为文件路径且工位声明支持时，将文件通过可信连接传到板端私有目录，以相机服务用户持有的 0600 文件传入 `--approved-isp`。板端会比对期初配置、核对 Gamma 生效曲线、完成检测后恢复和独立回读。配置与检测结果留在本工位。
- 更新电脑和 X5 两端启动器及板端检测 runner 后，可启用 `supportsIspComparison`。对照入口仅接受单独修改活动 Gamma 曲线的已核对配置。学员确认机位、照明和课程目标固定后，两段各采集 `seconds` 秒。检测完成、原始配置独立回读一致且停流后，可圈定同一目标区域，计算检出帧、连续检出帧和不匹配框，并把统计和原始回执一起导出。

工作台只会采用本轮 ID、模型 SHA-256、ISP 回读和停流均匹配的结果。未配置时可手动运行板端入口并读取归档。若工位突然退出并留下 `.course-detection-active`，先由助教确认板端运行进程已结束、原始 ISP 和停流已核对，再移除空的占用目录。
