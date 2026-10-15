#!/usr/bin/env python3
"""SDK-runner command for a private, loopback UVC camera daemon/tunnel.

Credentials and endpoint live in a private config, never the request or receipt.
"""
import argparse
import base64
import hashlib
import json
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def execute(config_file, operation, request_file, job_dir):
    config = json.loads(Path(config_file).read_text())
    parsed = urlparse(config["url"])
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password:
        raise ValueError("private_loopback_endpoint_required")
    request = json.loads(Path(request_file).read_text())
    if request["operation"] != operation:
        raise ValueError("operation_mismatch")
    data = json.dumps({"operation": operation, "inputs": request["inputs"]}, separators=(",", ":")).encode()
    call = urllib.request.Request(config["url"].rstrip("/") + "/execute", data=data,
                                  headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
    # The daemon is reached through an existing loopback SSH tunnel, never a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(call, timeout=20) as response:
        body = response.read(24 * 1024 * 1024 + 1)
        if len(body) > 24 * 1024 * 1024:
            raise ValueError("result_limit")
        result = json.loads(body)
    destination = Path(job_dir).resolve()
    if "contentBase64" in result:
        image = base64.b64decode(result.pop("contentBase64"), validate=True)
        if hashlib.sha256(image).hexdigest() != result["sha256"]:
            raise ValueError("image_hash_mismatch")
        filename = "frame.png" if result["mimeType"] == "image/png" else "frame.jpg"
        (destination / filename).write_bytes(image)
        result["artifactFile"] = filename
        # The runner derives dimensions from actual file bytes, never the SDK's
        # claims. Frame provenance is represented by its dedicated server type.
        for field in ["width", "height", "source", "inputKind"]:
            result.pop(field, None)
    (destination / "result.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("operation")
    parser.add_argument("request_file")
    parser.add_argument("job_dir")
    args = parser.parse_args()
    execute(args.config, args.operation, args.request_file, args.job_dir)
