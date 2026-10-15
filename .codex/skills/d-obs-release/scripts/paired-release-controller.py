#!/usr/bin/env python3
"""Root-only paired camera release controller. No change occurs without an explicit phase."""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import grp
import re
import secrets
import signal
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

SCHEMA = 'rdk.camera-paired-release-controller.v1'
PROOF_SCHEMA = 'rdk.camera-paired-release-candidate-tests.v1'
ENV_FILE = Path('/etc/rdk-camera-account-bridge.env')
STATE_DIR = Path('/var/lib/d-obs/camera-bridge')
SYSTEMD_DIR = Path('/etc/systemd/system')
DROPIN_NAME = 'zz-rdk-camera-account-bridge.conf'
SHA = re.compile(r'^[a-f0-9]{64}$')
UNIT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$')

class ReleaseError(RuntimeError):
    pass

def need(condition, code):
    if not condition:
        raise ReleaseError(code)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def regular(path, private=False, uid=0, max_bytes=64 * 1024 * 1024):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_size <= max_bytes, 'file_type_or_size_invalid')
        if private:
            need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o600, 'private_file_permissions_invalid')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(max_bytes + 1)
        need(len(data) == info.st_size, 'file_changed_during_read')
        return data, info
    finally:
        os.close(fd)

def private_directory(path, uid=0, gid=None, create=False):
    path = Path(path)
    need(path.is_absolute(), 'private_directory_not_absolute')
    if create:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'private_directory_type_invalid')
    need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_permissions_invalid')
    need(path.resolve() == path, 'private_directory_symlink_invalid')
    if gid is not None:
        need(info.st_gid == gid, 'private_directory_group_invalid')

def atomic_file(path, data, mode=0o600):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(8) + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.fchmod(fd, mode)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()

def relative(name):
    need(isinstance(name, str) and 0 < len(name) <= 500 and not re.search(r'[\x00-\x1f\x7f\\]', name), 'relative_path_invalid')
    parts = PurePosixPath(name)
    need(not parts.is_absolute() and all(part not in ('', '.', '..') for part in name.split('/')), 'relative_path_invalid')
    return parts

def safe_target(root, name, create=False, allow_missing=False):
    parts = relative(name)
    root = Path(root)
    current = root
    for part in parts.parts[:-1]:
        current /= part
        if create and not current.exists() and not current.is_symlink():
            current.mkdir(mode=0o755)
        if allow_missing and not current.exists() and not current.is_symlink():
            continue  # Read-only baseline checks may inspect a wholly new namespace.
        need(current.is_dir() and not current.is_symlink(), 'payload_parent_symlink_or_type_invalid')
    need(current.resolve().is_relative_to(root.resolve()), 'payload_escapes_candidate')
    return root / name

def payload_copy(root, name, data):
    destination = safe_target(root, name, create=True)
    if destination.exists() or destination.is_symlink():
        need(not destination.is_dir(), 'payload_target_is_directory')
        destination.unlink()  # A cp -al clone shares old inodes: never overwrite in place.
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def switch_pointer(current, expected, target):
    current = Path(current)
    need(current.is_symlink() and current.resolve() == Path(expected), 'current_changed_before_switch')
    destination = Path(target)
    resolved_target = (destination if destination.is_absolute() else current.parent / destination).resolve()
    temporary = current.with_name('.' + current.name + '.camera-' + secrets.token_hex(8))
    try:
        temporary.symlink_to(target)
        need(current.is_symlink() and current.resolve() == Path(expected), 'current_changed_before_switch')
        os.replace(temporary, current)
        need(current.resolve() == resolved_target, 'current_changed_after_switch')
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()

def run(args, timeout=15):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ReleaseError('command_timeout') from None
    need(result.returncode == 0, 'command_failed')
    return result.stdout

def health_url(url, source=False):
    parsed = urlsplit(url)
    need(not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, 'health_url_invalid')
    need(parsed.hostname and parsed.path.startswith('/') and not re.search(r'[\x00-\x20\x7f]', url), 'health_url_invalid')
    if source:
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = False
        need(parsed.scheme == 'http' and loopback, 'source_health_requires_numeric_loopback_http')
    else:
        need(parsed.scheme == 'https', 'public_health_requires_https')
    need(parsed.port is None or 0 < parsed.port <= 65535, 'health_url_invalid')
    return parsed

def health(url):
    parsed = urlsplit(url)
    health_url(url, source=parsed.scheme == 'http')
    if parsed.scheme == 'http':
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=3)
    else:
        need(parsed.scheme == 'https' and parsed.hostname, 'health_url_invalid')
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=3)
    try:
        connection.request('GET', parsed.path or '/', headers={'Accept': 'application/json', 'Connection': 'close'})
        response = connection.getresponse()
        need(response.status == 200, 'health_status_failed')
        need(len(response.read(65537)) <= 65536, 'health_response_limit')
    finally:
        connection.close()

def snapshot_file(path, backup):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return {'exists': False}
    data, info = regular(path)
    need(info.st_uid == 0, 'external_configuration_owner_invalid')
    atomic_file(backup, data)
    return {'exists': True, 'sha256': digest(data), 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid, 'backup': str(backup)}

def matches_snapshot(path, snapshot):
    path = Path(path)
    if not snapshot['exists']:
        return not path.exists() and not path.is_symlink()
    try:
        data, info = regular(path)
        return digest(data) == snapshot['sha256'] and info.st_uid == snapshot['uid'] and info.st_gid == snapshot['gid'] and stat.S_IMODE(info.st_mode) == snapshot['mode']
    except (OSError, ReleaseError):
        return False

class Controller:
    def __init__(self, config, config_hash):
        self.config = config
        self.config_hash = config_hash
        need(config.get('schema') == SCHEMA and re.fullmatch(r'[a-z0-9-]{1,80}', config.get('taskId', '')), 'controller_config_invalid')
        self.journal_dir = Path(config['journalDir'])
        private_directory(self.journal_dir, create=True)
        self.journal_path = self.journal_dir / 'controller-journal.json'
        lock_fd = os.open(self.journal_dir / 'controller.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock_info = os.fstat(lock_fd)
        need(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == 0 and stat.S_IMODE(lock_info.st_mode) == 0o600, 'controller_lock_invalid')
        self.lock = os.fdopen(lock_fd, 'a+b')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError('controller_already_running') from None
        self.env_file = ENV_FILE
        self.state_dir = STATE_DIR
        self.systemd_dir = SYSTEMD_DIR
        need(set(config.get('components', {})) == {'dobs', 'studio'}, 'components_invalid')
        need(set(config.get('units', {})) == {'dobs', 'standby', 'primary'}, 'unit_roles_invalid')
        need(config.get('publicHealthUrls') and all(urlsplit(url).scheme == 'https' for url in config['publicHealthUrls']), 'public_health_urls_required')
        need(all(value.get('healthUrls') for value in config['units'].values()), 'source_health_urls_required')
        for url in config['publicHealthUrls']:
            health_url(url)
        for unit in config['units'].values():
            for url in unit['healthUrls']:
                health_url(url, source=True)
        need({'/healthz', '/readyz'}.issubset({urlsplit(url).path for url in config['units']['dobs']['healthUrls']}), 'dobs_health_and_ready_required')
        names = [value['name'] for value in config['units'].values()]
        need(len(set(names)) == 3 and all(UNIT.fullmatch(name) for name in names), 'unit_names_invalid')
        for component in config['components'].values():
            for key in ('current', 'base', 'candidate', 'payloadRoot', 'manifestPath'):
                need(Path(component[key]).is_absolute(), 'component_path_not_absolute')
            need(Path(component['candidate']).parent == Path(component['base']).parent and component['candidate'] != component['base'], 'candidate_location_invalid')
            need(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{1,150}\.json', component['manifestName'] or ''), 'manifest_name_invalid')
            need(SHA.fullmatch(component['manifestSha256']), 'manifest_hash_invalid')
            need(component['files'] and component['baselineFiles'], 'component_file_lists_required')
            need(component['manifestName'] not in component['files'] and component['manifestName'] not in component['baselineFiles'], 'manifest_name_not_unique')
            for name, expected in component['files'].items():
                relative(name)
                need(not name.startswith(('node_modules/', 'ops/')) and not name.endswith('.env') and 'studio-alert-worker' not in name and SHA.fullmatch(expected), 'payload_scope_invalid')
            for name, expected in component['baselineFiles'].items():
                relative(name)
                need(SHA.fullmatch(expected), 'baseline_hash_invalid')
            need(isinstance(component.get('requiredChecks', []), list) and all(isinstance(name, str) and re.fullmatch(r'[a-zA-Z][a-zA-Z0-9]{0,79}', name) for name in component.get('requiredChecks', [])), 'additional_proof_checks_invalid')
            need(isinstance(component.get('requiredEvidence', {}), dict) and all(re.fullmatch(r'[a-zA-Z][a-zA-Z0-9]{0,79}', name) and isinstance(value, str) and SHA.fullmatch(value) for name, value in component.get('requiredEvidence', {}).items()), 'additional_proof_evidence_invalid')
        self.journal = None

    def close(self):
        self.lock.close()

    def save(self):
        atomic_file(self.journal_path, (json.dumps(self.journal, indent=2) + '\n').encode())

    def load(self):
        data, _ = regular(self.journal_path, private=True)
        self.journal = json.loads(data)
        need(self.journal['configSha256'] == self.config_hash, 'controller_configuration_changed')

    def dropin(self, role):
        return self.systemd_dir / (self.config['units'][role]['name'] + '.d') / DROPIN_NAME

    def inspect_unit(self, role):
        spec = self.config['units'][role]
        output = run(['systemctl', 'show', spec['name'], '--property=User,Group,MainPID,ActiveState']).decode()
        fields = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        pid = fields.get('MainPID', '')
        need(fields.get('ActiveState') == 'active' and re.fullmatch(r'[1-9][0-9]*', pid), 'unit_not_active')
        username = fields.get('User') or 'root'
        account = pwd.getpwuid(int(username)) if username.isdecimal() else pwd.getpwnam(username)
        group_name = fields.get('Group')
        group = (grp.getgrgid(int(group_name)) if group_name.isdecimal() else grp.getgrnam(group_name)).gr_gid if group_name else account.pw_gid
        process_info = Path('/proc/' + pid).stat()
        need(process_info.st_uid == account.pw_uid and process_info.st_gid == group, 'unit_process_user_mismatch')
        executable = Path('/proc/' + pid + '/exe').resolve()
        need(executable.name == 'node', 'unit_executable_not_node')
        version = run([str(executable), '--version'], timeout=5).decode().strip()
        need(re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', version), 'unit_node_version_invalid')
        return {'user': username, 'uid': account.pw_uid, 'gid': group, 'nodeExecutable': str(executable), 'nodeVersion': version, 'cwd': str(Path('/proc/' + pid + '/cwd').resolve())}

    def validate_baseline(self, component):
        current, base = Path(component['current']), Path(component['base'])
        need(current.is_symlink() and current.resolve() == base and base.is_dir() and base.resolve() == base, 'live_baseline_changed')
        for name in component['files']:
            existing = safe_target(base, name, allow_missing=True)
            if existing.exists() or existing.is_symlink():
                need(name in component['baselineFiles'], 'replaced_file_missing_baseline_hash')
        for name, expected in component['baselineFiles'].items():
            need(digest(regular(safe_target(base, name))[0]) == expected, 'live_baseline_file_changed')

    def validate_payload(self, component):
        manifest_data, _ = regular(component['manifestPath'])
        need(digest(manifest_data) == component['manifestSha256'], 'payload_manifest_changed')
        manifest = json.loads(manifest_data)
        need(manifest['baseRelease'] == component['base'] and manifest['files'] == component['files'], 'payload_manifest_binding_invalid')
        root = Path(component['payloadRoot'])
        need(root.is_dir() and root.resolve() == root, 'payload_root_invalid')
        for name, expected in component['files'].items():
            need(digest(regular(safe_target(root, name))[0]) == expected, 'payload_file_changed')
        return manifest_data

    def validate_candidate(self, component):
        candidate = Path(component['candidate'])
        need(candidate.is_dir() and not candidate.is_symlink() and candidate.resolve() == candidate, 'candidate_directory_invalid')
        for name, expected in component['files'].items():
            need(digest(regular(safe_target(candidate, name))[0]) == expected, 'candidate_file_changed')
        need(digest(regular(candidate / component['manifestName'])[0]) == component['manifestSha256'], 'candidate_manifest_changed')
        for name, expected in component['baselineFiles'].items():
            if name not in component['files']:
                need(digest(regular(safe_target(candidate, name))[0]) == expected, 'candidate_inherited_file_changed')

    def prepare(self):
        need(not self.journal_path.exists(), 'prepare_already_exists')
        for component in self.config['components'].values():
            self.validate_baseline(component)
            self.validate_payload(component)
            need(not Path(component['candidate']).exists(), 'candidate_already_exists')
        units = {role: self.inspect_unit(role) for role in self.config['units']}
        for role, details in units.items():
            component = self.config['components']['dobs' if role == 'dobs' else 'studio']
            suffix = self.config['units'][role].get('cwdRelative', '')
            if suffix:
                relative(suffix)
            need(Path(details['cwd']) == Path(component['base']) / suffix, 'unit_baseline_cwd_mismatch')
        before = {}
        backup_dir = self.journal_dir / 'external-before'
        private_directory(backup_dir, create=True)
        for label, target in [('shared-env', self.env_file)] + [('dropin-' + role, self.dropin(role)) for role in self.config['units']]:
            before[label] = snapshot_file(target, backup_dir / (label + '.backup'))
            if label == 'shared-env' and before[label]['exists']:
                need(before[label]['mode'] == 0o600, 'shared_env_permissions_invalid')
        if self.state_dir.exists() or self.state_dir.is_symlink():
            private_directory(self.state_dir, units['dobs']['uid'], units['dobs']['gid'])
        self.journal = {'schema': SCHEMA, 'configSha256': self.config_hash, 'phase': 'preparing', 'units': units, 'externalBefore': before, 'originalLinks': {name: os.readlink(value['current']) for name, value in self.config['components'].items()}, 'plannedHashes': {}, 'changed': []}
        self.save()
        for name, component in self.config['components'].items():
            self.validate_baseline(component)
            candidate = Path(component['candidate'])
            candidate.mkdir(mode=0o755)
            run(['cp', '-al', component['base'] + '/.', str(candidate)], timeout=60)
            need(not (candidate / component['manifestName']).exists(), 'manifest_name_not_unique')
            for file in component['files']:
                data, _ = regular(safe_target(Path(component['payloadRoot']), file))
                need(digest(data) == component['files'][file], 'payload_file_changed')
                payload_copy(candidate, file, data)
            payload_copy(candidate, component['manifestName'], self.validate_payload(component))
            self.validate_candidate(component)
            self.validate_baseline(component)
            self.journal['changed'].append('prepared-' + name)
            self.save()
        self.journal['phase'] = 'prepared'
        self.save()

    def check_proof(self, component_name, proof_spec):
        component = self.config['components'][component_name]
        raw, _ = regular(proof_spec['path'], private=True, max_bytes=2 * 1024 * 1024)
        need(SHA.fullmatch(proof_spec['sha256']) and digest(raw) == proof_spec['sha256'], 'candidate_proof_hash_mismatch')
        proof = json.loads(raw)
        need(proof.get('schema') == PROOF_SCHEMA and proof.get('component') == component_name and proof.get('candidate') == component['candidate'], 'candidate_proof_identity_invalid')
        need(proof.get('manifestSha256') == component['manifestSha256'] and proof.get('files') == component['files'], 'candidate_proof_artifacts_mismatch')
        need(all(type(proof.get(key)) is int and proof[key] == 0 for key in ('testExitCode', 'productionStateWrites', 'hardwareOperations')) and all(proof.get('checks', {}).get(key) is True for key in ('moduleTests', 'readOnlySmoke', 'pairedAccountBridgeSmoke')), 'candidate_proof_tests_not_passed')
        expected_pair = {name: {'candidate': value['candidate'], 'manifestSha256': value['manifestSha256']} for name, value in self.config['components'].items()}
        need(proof.get('pairedCandidates') == expected_pair, 'candidate_proof_pair_binding_invalid')
        need(all(proof.get('checks', {}).get(name) is True for name in component.get('requiredChecks', [])), 'candidate_additional_check_not_passed')
        need(all(proof.get('evidenceSha256', {}).get(name) == value for name, value in component.get('requiredEvidence', {}).items()), 'candidate_additional_evidence_mismatch')
        roles = ['dobs'] if component_name == 'dobs' else ['standby', 'primary']
        expected = {(self.journal['units'][role]['nodeExecutable'], self.journal['units'][role]['nodeVersion']) for role in roles}
        rows = proof.get('nodes', [])
        need(rows and all(type(row.get('testExitCode')) is int and row['testExitCode'] == 0 for row in rows), 'candidate_proof_node_tests_failed')
        observed = {(row.get('executable'), row.get('version')) for row in rows}
        need(len(rows) == len(observed) and observed == expected, 'candidate_proof_production_node_mismatch')
        log, _ = regular(proof['testLogPath'], private=True, max_bytes=32 * 1024 * 1024)
        need(SHA.fullmatch(proof.get('testLogSha256', '')) and digest(log) == proof['testLogSha256'], 'candidate_proof_log_mismatch')

    def same_external(self):
        for label, target in [('shared-env', self.env_file)] + [('dropin-' + role, self.dropin(role)) for role in self.config['units']]:
            need(matches_snapshot(target, self.journal['externalBefore'][label]), 'external_configuration_changed')

    def owned_currents(self):
        for component in self.config['components'].values():
            current = Path(component['current'])
            need(current.is_symlink() and current.resolve() in (Path(component['base']), Path(component['candidate'])), 'rollback_current_owned_by_later_release')

    def planned_configuration(self):
        for label, target in [('shared-env', self.env_file)] + [('dropin-' + role, self.dropin(role)) for role in self.config['units']]:
            data, info = regular(target)
            need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == (0o600 if label == 'shared-env' else 0o644) and digest(data) == self.journal['plannedHashes'].get(label), 'active_configuration_changed')

    def restart_and_wait(self, role, expected_component, expected_environment=None):
        spec = self.config['units'][role]
        component = self.config['components'][expected_component]
        self.owned_currents()
        self.planned_configuration()
        need(Path(component['current']).resolve() == Path(component['candidate']), 'current_changed_before_restart')
        run(['systemctl', 'restart', spec['name']], timeout=45)
        deadline = time.monotonic() + 60
        while True:
            try:
                details = self.inspect_unit(role)
                saved = self.journal['units'][role]
                need(all(details[key] == saved[key] for key in ('uid', 'gid', 'nodeExecutable', 'nodeVersion')), 'unit_identity_changed')
                need(Path(details['cwd']) == Path(component['candidate']) / spec.get('cwdRelative', ''), 'unit_not_using_candidate')
                if expected_environment is not None:
                    pid = run(['systemctl', 'show', spec['name'], '--property=MainPID', '--value'], timeout=5).decode().strip()
                    entries = Path('/proc/' + pid + '/environ').read_bytes().split(b'\0')
                    actual = dict(entry.split(b'=', 1) for entry in entries if b'=' in entry)
                    need(all(actual.get(key.encode()) == value.encode() for key, value in expected_environment.items()), 'unit_bridge_environment_mismatch')
                for url in spec['healthUrls']:
                    health(url)
                need(Path(component['current']).resolve() == Path(component['candidate']), 'current_changed_after_restart')
                return
            except (OSError, ReleaseError, ValueError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise ReleaseError('unit_health_or_identity_timeout') from None
                time.sleep(1)

    def activate(self, proofs):
        self.load()
        need(self.journal['phase'] == 'prepared', 'activate_requires_prepared_phase')
        need(set(proofs) == {'dobs', 'studio'}, 'both_candidate_proofs_required')
        for name, component in self.config['components'].items():
            self.validate_baseline(component)
            self.validate_candidate(component)
            self.check_proof(name, proofs[name])
        self.same_external()
        for role in self.config['units']:
            actual = self.inspect_unit(role)
            need(actual == self.journal['units'][role], 'live_unit_changed_after_prepare')
        environment = {'RDK_VISION_BRIDGE_SECRET': secrets.token_hex(32), 'RDK_VISION_WORKSHOP_URL': 'http://127.0.0.1:18093', 'RDK_VISION_BRIDGE_STATE_DIR': str(self.state_dir), 'RDK_VISION_BRIDGE_ADAPTER_OWNERS': '{}'}
        env_data = ''.join(key + '=' + value + '\n' for key, value in environment.items()).encode()
        dropin_data = ('[Service]\nEnvironmentFile=' + str(self.env_file) + '\n').encode()
        self.journal['plannedHashes'] = {'shared-env': digest(env_data), **{'dropin-' + role: digest(dropin_data) for role in self.config['units']}}
        self.journal['phase'] = 'activating'
        self.save()
        try:
            user = self.journal['units']['dobs']
            if not self.state_dir.exists():
                self.state_dir.mkdir(parents=True, mode=0o700)
                os.chown(self.state_dir, user['uid'], user['gid'])
            private_directory(self.state_dir, user['uid'], user['gid'])
            self.same_external()
            for component in self.config['components'].values():
                self.validate_baseline(component)
            need(matches_snapshot(self.env_file, self.journal['externalBefore']['shared-env']), 'external_configuration_changed')
            atomic_file(self.env_file, env_data)
            for role in self.config['units']:
                destination = self.dropin(role)
                destination.parent.mkdir(mode=0o755, exist_ok=True)
                need(destination.parent.is_dir() and not destination.parent.is_symlink(), 'dropin_directory_invalid')
                parent_info = destination.parent.stat()
                need(parent_info.st_uid == 0 and not stat.S_IMODE(parent_info.st_mode) & 0o022, 'dropin_directory_permissions_invalid')
                need(matches_snapshot(destination, self.journal['externalBefore']['dropin-' + role]), 'external_configuration_changed')
                atomic_file(destination, dropin_data, 0o644)
            run(['systemctl', 'daemon-reload'], timeout=20)
            self.planned_configuration()
            dobs = self.config['components']['dobs']
            switch_pointer(dobs['current'], dobs['base'], dobs['candidate'])
            self.journal['changed'].append('activated-dobs')
            self.save()
            self.restart_and_wait('dobs', 'dobs', environment)
            studio = self.config['components']['studio']
            switch_pointer(studio['current'], studio['base'], studio['candidate'])
            self.journal['changed'].append('activated-studio')
            self.save()
            self.restart_and_wait('standby', 'studio', environment)
            self.restart_and_wait('primary', 'studio', environment)
            for url in self.config['publicHealthUrls']:
                health(url)
            for component in self.config['components'].values():
                need(Path(component['current']).resolve() == Path(component['candidate']), 'current_changed_during_activation')
                self.validate_candidate(component)
            self.planned_configuration()
            self.journal['phase'] = 'active'
            self.save()
        except BaseException:
            try:
                self.rollback()
            except BaseException:
                self.journal['phase'] = 'rollback_blocked_or_failed'
                self.save()
            raise
        finally:
            environment.clear()  # Never serialize credential values into the journal or report.

    def rollback(self):
        if self.journal is None:
            self.load()
        need(self.journal['phase'] in ('activating', 'active', 'rolling_back', 'rollback_blocked_or_failed'), 'rollback_phase_invalid')
        # A later release can depend on our shared configuration. Do not alter anything then.
        self.owned_currents()
        targets = [('shared-env', self.env_file)] + [('dropin-' + role, self.dropin(role)) for role in self.config['units']]
        for label, target in targets:
            if matches_snapshot(target, self.journal['externalBefore'][label]):
                continue
            data, info = regular(target)
            need(info.st_uid == 0 and digest(data) == self.journal['plannedHashes'].get(label), 'rollback_configuration_owned_by_later_change')
        self.journal['phase'] = 'rolling_back'
        self.save()
        for name, component in self.config['components'].items():
            self.owned_currents()
            if Path(component['current']).resolve() == Path(component['candidate']):
                original = self.journal['originalLinks'][name]
                target = Path(original)
                need((target if target.is_absolute() else Path(component['current']).parent / target).resolve() == Path(component['base']), 'rollback_original_link_invalid')
                switch_pointer(component['current'], component['candidate'], original)
        for label, target in targets:
            self.owned_currents()
            snapshot = self.journal['externalBefore'][label]
            if matches_snapshot(target, snapshot):
                continue
            owned, info = regular(target)
            need(info.st_uid == 0 and digest(owned) == self.journal['plannedHashes'].get(label), 'rollback_configuration_owned_by_later_change')
            if snapshot['exists']:
                data, _ = regular(snapshot['backup'], private=True)
                need(digest(data) == snapshot['sha256'], 'rollback_backup_corrupt')
                atomic_file(target, data, snapshot['mode'])
                os.chown(target, snapshot['uid'], snapshot['gid'])
            else:
                target.unlink()  # Only the just-verified task-owned content is removed.
        run(['systemctl', 'daemon-reload'], timeout=20)
        for role in ('dobs', 'standby', 'primary'):
            self.owned_currents()
            component = self.config['components']['dobs' if role == 'dobs' else 'studio']
            need(Path(component['current']).resolve() == Path(component['base']), 'rollback_current_changed_before_restart')
            run(['systemctl', 'restart', self.config['units'][role]['name']], timeout=45)
            deadline = time.monotonic() + 60
            while True:
                try:
                    details = self.inspect_unit(role)
                    need(Path(details['cwd']) == Path(component['base']) / self.config['units'][role].get('cwdRelative', ''), 'rollback_unit_cwd_invalid')
                    for url in self.config['units'][role]['healthUrls']:
                        health(url)
                    break
                except (OSError, ReleaseError, ValueError, http.client.HTTPException):
                    need(time.monotonic() < deadline, 'rollback_unit_health_timeout')
                    time.sleep(1)
        self.journal['phase'] = 'rolled_back'
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'activate', 'rollback', 'status'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--proofs', help='Root 0600 JSON mapping component -> {path,sha256}; required only for activate')
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.geteuid() == 0, 'controller_requires_linux_root')
    raw, _ = regular(args.config, private=True, max_bytes=2 * 1024 * 1024)
    controller = Controller(json.loads(raw), digest(raw))
    def interrupted(_signum, _frame):
        raise ReleaseError('controller_interrupted')
    for name in ('SIGTERM', 'SIGHUP', 'SIGINT'):
        signal.signal(getattr(signal, name), interrupted)
    try:
        if args.phase == 'prepare':
            controller.prepare()
        elif args.phase == 'activate':
            need(args.proofs, 'activate_proofs_required')
            proof_raw, _ = regular(args.proofs, private=True, max_bytes=1024 * 1024)
            controller.activate(json.loads(proof_raw))
        elif args.phase == 'rollback':
            controller.rollback()
        else:
            controller.load()
        print(json.dumps({'ok': True, 'phase': controller.journal['phase'], 'taskId': controller.config['taskId']}))
    finally:
        controller.close()

if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        code = str(error) if isinstance(error, ReleaseError) else 'controller_failed_no_private_details_logged'
        print(json.dumps({'ok': False, 'error': code}), file=sys.stderr)
        raise SystemExit(1)
