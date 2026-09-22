#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ros2-otel-bridge.py — 把 ROS 2 topic 桥接成 d-obs 的 OTLP/HTTP 指标（实验性）。

⚠️ 实验性脚本：开发与维护在 d-obs 仓库内完成，但尚未在真实 ROS 2 环境联调。
   首次接入请先用 --once 干跑核对报文，再挂 systemd 常驻。

把机器人侧的 ROS topic（如 /battery_percent、/cmd_vel、/joint_states）转成
OTLP Gauge 上报到 d-obs 的 /v1/metrics，从此机器人指标与云端应用在同一个
观测平台里查询、做看板、设告警。

依赖：
  pip3 install rclpy requests        # ROS 2 环境（apt 装 ros-<distro>-rclpy 更稳）

配置（环境变量或参数）：
  RDK_OBS_REPORT_URL   d-obs 基址，如 https://rdkstudio.d-robotics.cc/dobs
  RDK_OBS_INGEST_TOKEN 上报凭据（Authorization: Bearer <token>，接入凭据注册表签发）
  RDK_ROS_TOPICS       逗号分隔的 "topic=metric_name[:type]"，type 仅支持 gauge
                       例：/battery_percent=robot.battery.percent,/cmd_vel.linear.x=robot.cmd.linear_x

用法：
  python3 ros2-otel-bridge.py                 # 常驻
  python3 ros2-otel-bridge.py --once          # 采一轮就退出（干跑）
  python3 ros2-otel-bridge.py --print         # 不上报，只打印 OTLP JSON（调试）
"""

import argparse
import json
import os
import signal
import sys
import time
import threading

try:
    import requests
except ImportError:
    requests = None  # --print 模式可以不装

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import qos_profile_sensor_data
except ImportError:
    rclpy = None  # 允许在非 ROS 环境下 --help / --print 干跑

REPORT_URL = os.environ.get("RDK_OBS_REPORT_URL", "").rstrip("/")
INGEST_TOKEN = os.environ.get("RDK_OBS_INGEST_TOKEN", "")
TOPIC_SPEC = os.environ.get("RDK_ROS_TOPICS", "")
MESSAGE_TYPE = os.environ.get("RDK_ROS_MSG_TYPE", "std_msgs/msg/Float32")  # 全部 topic 用同一消息类型，v1 限制


def parse_topics(spec):
    """' /a=robot.a, /b=robot.b' → [('/a', 'robot.a'), ('/b', 'robot.b')]"""
    pairs = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "=" not in chunk:
            print(f"[bridge] 忽略无 metric 名的 topic 配置: {chunk!r}", file=sys.stderr)
            continue
        topic, metric = chunk.split("=", 1)
        pairs.append((topic.strip(), metric.strip()))
    return pairs


class TopicSampler(Node):
    """订阅全部 topic，最新值放 self.latest（线程锁保护）。"""

    def __init__(self, topics):
        super().__init__("d_obs_ros_bridge")
        self.latest = {}
        self.lock = threading.Lock()
        for topic, metric in topics:
            self.create_subscription(
                MESSAGE_TYPE, topic,
                (lambda msg, m=metric: self._on_message(m, msg)),
                qos_profile_sensor_data,
            )
            print(f"[bridge] 订阅 {topic} → {metric}")

    def _on_message(self, metric, msg):
        value = getattr(msg, "data", None)
        if isinstance(value, (int, float)):
            with self.lock:
                self.latest[metric] = float(value)


def build_otlp_payload(readings, now_ns):
    """readings: {metric: value} → OTLP/HTTP JSON（ExportMetricsServiceRequest 精简形）。"""
    metrics = [
        {
            "name": name,
            "gauge": {"dataPoints": [{"asDouble": value, "timeUnixNano": str(now_ns)}]},
        }
        for name, value in sorted(readings.items())
    ]
    if not metrics:
        return None
    return {
        "resourceMetrics": [{
            "resource": {"attributes": [{
                "key": "service.name",
                "value": {"stringValue": os.environ.get("RDK_ROS_SERVICE_NAME", "ros2-robot")},
            }]},
            "scopeMetrics": [{"metrics": metrics}],
        }],
    }


def push(payload):
    response = requests.post(
        f"{REPORT_URL}/v1/metrics",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            **({"authorization": f"Bearer {INGEST_TOKEN}"} if INGEST_TOKEN else {}),
        },
        timeout=10,
    )
    if response.status_code >= 300:
        raise RuntimeError(f"OTLP 上报 HTTP {response.status_code}: {response.text[:200]}")


def main():
    parser = argparse.ArgumentParser(description="ROS 2 topic → d-obs OTLP 指标桥（实验性）")
    parser.add_argument("--once", action="store_true", help="采一轮就退出")
    parser.add_argument("--interval", type=float, default=15.0, help="上报间隔秒，默认 15")
    parser.add_argument("--print", action="store_true", help="只打印 OTLP JSON，不上报")
    args = parser.parse_args()

    topics = parse_topics(TOPIC_SPEC)
    if not topics:
        print("RDK_ROS_TOPICS 未配置，例：/battery_percent=robot.battery.percent", file=sys.stderr)
        sys.exit(2)
    if not args.print and (not REPORT_URL or not requests):
        print("RDK_OBS_REPORT_URL 未配置或缺 requests 库", file=sys.stderr)
        sys.exit(2)
    if rclpy is None:
        print("缺 rclpy：请在 ROS 2 环境运行，或用 --print 干跑", file=sys.stderr)
        sys.exit(2)

    rclpy.init()
    node = TopicSampler(topics)
    spinner = threading.Thread(target=rclpy.spin, daemon=True)
    spinner.start()

    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())

    print(f"[bridge] 上报间隔 {args.interval}s → {REPORT_URL or '(print 模式)'}")
    while not stopping.is_set():
        with node.lock:
            readings = dict(node.latest)
        now_ns = time.time_ns()
        payload = build_otlp_payload(readings, now_ns)
        if payload is None:
            print("[bridge] 暂无新读数")
        elif args.print:
            print(json.dumps(payload, indent=2))
        else:
            try:
                push(payload)
                print(f"[bridge] 上报 {len(readings)} 个指标")
            except Exception as error:  # 上报失败不退出，下一轮重试
                print(f"[bridge] 上报失败: {error}", file=sys.stderr)
        if args.once:
            break
        stopping.wait(args.interval)

    rclpy.shutdown()


if __name__ == "__main__":
    main()
