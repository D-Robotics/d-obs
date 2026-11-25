#!/usr/bin/env python3
"""Connect a configured classroom station to its X5 detection runner."""

import argparse
import base64
from contextlib import nullcontext
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import uuid

MAX_ASSET = 16 * 1024 * 1024
ARCHIVED = re.compile(r'(?:receipt|original-isp|loaded-isp|restored-isp)\.json|'
                      r'(?:frame-\d{5}|static-detection)\.jpg|board-run\.log')


def config_from(path):
    with Path(path).open() as source:
        return json.load(source)


def client(options):
    config = config_from(options.config)
    run_id = str(uuid.UUID(os.environ['RDK_COURSE_RUN_ID']))
    model = os.environ['RDK_COURSE_MODEL_SHA256']
    if not re.fullmatch(r'[a-f0-9]{64}', model):
        raise ValueError('invalid_classroom_model_hash')
    output = Path(os.environ['RDK_COURSE_RUN_ARCHIVE'])
    # Only a provisioned SSH config alias is accepted. OpenSSH resolves the
    # identity, target device and pinned host key through the station's config.
    host = config['sshHost']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,119}', host):
        raise ValueError('invalid_station_ssh_alias')
    command = ['python3', config['boardBridge'], 'board', '--config',
               config['boardConfig'], '--run-id', run_id, '--model-hash', model]
    approved = os.environ.get('RDK_COURSE_APPROVED_ISP')
    if os.environ.get('RDK_COURSE_COMPARE_ISP') == '1':
        if not approved:
            raise ValueError('comparison_requires_approved_gamma')
        command.append('--comparison')
    with Path(approved).open('rb') if approved else nullcontext(subprocess.DEVNULL) as document:
        ssh_config = ['-F', config['sshConfig']] if config.get('sshConfig') else []
        ssh = [config.get('sshExecutable', 'ssh'), *ssh_config, '-T', '-o', 'BatchMode=yes', '-o',
               'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=6', host, shlex.join(command)]
        with subprocess.Popen(ssh, stdin=document, stdout=subprocess.PIPE) as process:
            try:
                while line := process.stdout.readline(MAX_ASSET * 2):
                    message = json.loads(line)
                    name = message['file']
                    if not ARCHIVED.fullmatch(name):
                        raise ValueError('unexpected_board_asset')
                    content = base64.b64decode(message['base64'], validate=True)
                    if len(content) > MAX_ASSET:
                        raise ValueError('board_asset_size_limit')
                    temporary = output / (name + '.part')
                    temporary.write_bytes(content)
                    temporary.replace(output / name)
            finally:
                process.stdout.close()
            return process.wait()


def board(options):
    import fcntl
    import hashlib
    import pwd

    config = config_from(options.config)
    model = Path(config['model'])
    if hashlib.sha256(model.read_bytes()).hexdigest() != options.model_hash:
        raise ValueError('station_model_sha256_mismatch')
    run_id = str(uuid.UUID(options.run_id))
    root = Path(config['runRoot'])
    archive = root / run_id
    service = config['cameraService']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', service):
        raise ValueError('invalid_camera_service')
    user = pwd.getpwnam(config['cameraUser'])
    lock = (root / '.station-detector.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    journal = Path(config_from(config['cameraConfig'])['stateDir']) / 'isp-write.json'
    if journal.exists():
        state = config_from(journal)
        if state.get('cleanupRequired') or state.get('outcome') in ('pending','unconfirmed','confirmed'):
            raise RuntimeError('previous_camera_recovery_required')
    payload = sys.stdin.buffer.read(MAX_ASSET + 1)
    if len(payload) > MAX_ASSET:
        raise ValueError('approved_isp_size_limit')
    if options.comparison and not payload:
        raise ValueError('comparison_requires_approved_gamma')
    mode = ['--current-isp']
    if payload:
        isp = root / (run_id + '.isp.json')
        fd = os.open(isp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            os.fchown(handle.fileno(), user.pw_uid, user.pw_gid)
            handle.write(payload)
        mode = ['--approved-isp', str(isp)]
        if options.comparison:
            mode.append('--compare-approved')

    def send(name, content):
        print(json.dumps({'file': name, 'base64': base64.b64encode(content).decode('ascii')},
                         separators=(',', ':')), flush=True)

    receipt = archive / 'receipt.json'
    sent = set()
    previous = None

    def publish(final):
        nonlocal previous
        if not receipt.is_file():
            return
        content = receipt.read_bytes()
        if previous == content and not final:
            return
        report = json.loads(content)
        assets = [*report.get('ispSnapshots', {})]
        if report.get('staticBpu'):
            assets.append('static-detection.jpg')
        frames = report['frames'] if final else report['frames'][-6:]
        assets.extend(frame['file'] for frame in frames)
        for name in assets:
            if name not in sent and ARCHIVED.fullmatch(name):
                send(name, (archive / name).read_bytes())
                sent.add(name)
        if previous != content:
            send('receipt.json', content)
            previous = content

    def service_command(operation):
        subprocess.run(['systemctl', operation, service], stdout=subprocess.DEVNULL, check=True)

    service_command('is-active')
    # root maintains the service. The camera process uses the existing
    # unprivileged SDK user so the original private ISP journal is reused.
    flags = {'profile': 'profile', 'model': 'model', 'static-image': 'staticImage', 'model-zoo': 'modelZoo',
             'camera-module': 'cameraModule', 'camera-config': 'cameraConfig'}
    arguments = [value for flag, name in flags.items() for value in ('--' + flag, config[name])]
    command = ['runuser', '-u', user.pw_name, '--', 'python3', config['runner'], *arguments, *mode,
               '--output', str(archive), '--run-id', run_id, '--seconds', str(config.get('seconds', 28))]
    log_file = root / (run_id + '.log')
    try:
        service_command('stop')
        with log_file.open('xb') as log, subprocess.Popen(command, stdout=log, stderr=log) as worker:
            try:
                while worker.poll() is None:
                    publish(False)
                    time.sleep(.13)
                publish(True)
            finally:
                if worker.poll() is None:
                    worker.terminate()
                    worker.wait()
        send('board-run.log', log_file.read_bytes())
        return worker.returncode
    finally:
        try:
            service_command('start')
            service_command('is-active')
        finally:
            lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('side', choices=('client', 'board'))
    parser.add_argument('--config', required=True)
    parser.add_argument('--run-id')
    parser.add_argument('--model-hash')
    parser.add_argument('--comparison', action='store_true')
    options = parser.parse_args()
    if options.side == 'client':
        return client(options)
    if not options.run_id or not options.model_hash:
        parser.error('Board mode requires the run ID and model hash.')

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    return board(options)


if __name__ == '__main__':
    sys.exit(main())
