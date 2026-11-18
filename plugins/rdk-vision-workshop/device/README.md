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
