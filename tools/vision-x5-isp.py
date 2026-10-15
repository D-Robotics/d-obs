#!/usr/bin/env python3
"""Compiler-described HBN ISP snapshots. Raw SDK structs stay in private storage.

Only fields described by the compiled SDK bridge (or a named private operator
policy) can be edited. Every write is compared to an independent normalized
getter, including fields that are not exposed as editable JSON.
"""
import base64
import ctypes
import hashlib
import json
import math
import os
import re
import stat
import struct
import tempfile
import uuid
from pathlib import Path

KIND = 'x5-hbn-isp-v2'
TYPES = ('i', 'I', 'f', 'H', 'h', 'B', 'b', 'd')
MAX_LIBRARY = 16 * 1024 * 1024
EXPORT_BINDING = 'x5-effect-library-export-binding-v1'
EXPORT_PROFILE = ('sdkVersion', 'sensorConfig', 'cameraMode', 'csiPort')


def finite_number(value):
    if type(value) not in (int, float): return False
    try: return math.isfinite(value)
    except OverflowError: return False


def pointer_parts(pointer):
    if not isinstance(pointer, str) or not 1 < len(pointer) <= 512 or not pointer.startswith('/') or re.search(r'~(?![01])', pointer):
        raise ValueError('vendor_export_pointer_invalid')
    parts = [part.replace('~1', '/').replace('~0', '~') for part in pointer.split('/')[1:]]
    if any(not part or part in ('__proto__', 'prototype', 'constructor') for part in parts): raise ValueError('vendor_export_pointer_invalid')
    return parts


def validate_export_binding(binding, config):
    """Private operator schema only: no vendor field mapping is inferred."""
    keys = {'schema', *EXPORT_PROFILE, 'layoutHash', 'templateSha256', 'baselineModulesSha256', 'evidenceRef', 'mappings'}
    if not isinstance(binding, dict) or set(binding) != keys or binding.get('schema') != EXPORT_BINDING:
        raise ValueError('vendor_export_binding_invalid')
    if any(binding.get(key) != config.get(key) for key in EXPORT_PROFILE): raise ValueError('vendor_export_profile_mismatch')
    if type(binding['csiPort']) is not int: raise ValueError('vendor_export_profile_mismatch')
    if any(not isinstance(binding.get(key), str) or not re.fullmatch('[a-f0-9]{64}', binding[key]) for key in ('layoutHash', 'templateSha256', 'baselineModulesSha256')):
        raise ValueError('vendor_export_binding_invalid')
    if not isinstance(binding['evidenceRef'], str) or not binding['evidenceRef'].strip() or len(binding['evidenceRef']) > 300 or re.search(r'[\x00-\x1f\x7f]', binding['evidenceRef']):
        raise ValueError('vendor_export_binding_invalid')
    if not isinstance(binding['mappings'], list) or not 0 < len(binding['mappings']) <= 512: raise ValueError('vendor_export_binding_invalid')
    sources, targets = set(), []
    for row in binding['mappings']:
        if not isinstance(row, dict) or set(row) - {'module', 'field', 'jsonPointer', 'encoding', 'min', 'max', 'scale', 'rounding', 'shape', 'order'} or not {'module', 'field', 'jsonPointer', 'encoding', 'min', 'max'} <= set(row):
            raise ValueError('vendor_export_mapping_invalid')
        if any(not isinstance(row[key], str) or not re.fullmatch(r'[A-Za-z0-9_.]{1,200}', row[key]) for key in ('module', 'field')):
            raise ValueError('vendor_export_mapping_invalid')
        source = (row['module'], row['field']); target = pointer_parts(row['jsonPointer'])
        if source in sources or any(target[:len(old)] == old or old[:len(target)] == target for old in targets): raise ValueError('vendor_export_mapping_overlap')
        sources.add(source); targets.append(target)
        if row['encoding'] not in ('integer', 'float32', 'float64') or any(not finite_number(row[key]) for key in ('min', 'max')) or row['min'] > row['max']:
            raise ValueError('vendor_export_mapping_invalid')
        scale = row.get('scale', 1)
        if not finite_number(scale) or scale == 0: raise ValueError('vendor_export_mapping_invalid')
        if (row['encoding'] == 'integer' and row.get('rounding') != 'nearest-even') or (row['encoding'] != 'integer' and 'rounding' in row): raise ValueError('vendor_export_rounding_required')
        if ('shape' in row) != ('order' in row): raise ValueError('vendor_export_array_layout_required')
        if 'shape' in row:
            shape, order = row['shape'], row['order']
            if not isinstance(shape, list) or not 1 <= len(shape) <= 4 or any(type(n) is not int or not 1 <= n <= 65536 for n in shape): raise ValueError('vendor_export_array_layout_invalid')
            count = math.prod(shape)
            if count > 65536 or not isinstance(order, list) or len(order) != count or any(type(n) is not int for n in order) or set(order) != set(range(count)):
                raise ValueError('vendor_export_array_layout_invalid')
    try: size = len(json.dumps(binding, allow_nan=False, separators=(',', ':')))
    except (ValueError, TypeError): raise ValueError('vendor_export_binding_invalid') from None
    if size > 1024 * 1024: raise ValueError('vendor_export_binding_invalid')


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, allow_nan=False, separators=(',', ':'))
            out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def private_json(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd) as src:
        mode = os.fstat(src.fileno())
        if not stat.S_ISREG(mode.st_mode) or mode.st_uid != os.geteuid() or mode.st_mode & 0o077 or mode.st_size > 32 * 1024 * 1024:
            raise ValueError('private_snapshot_required')
        return json.load(src)


class Isp:
    def __init__(self, backend, config, error, digest):
        self.backend, self.config, self.error, self.digest = backend, config, error, digest
        self.lib = backend.lib
        self.scene_generation = 0
        self.session_id = getattr(backend, 'pipeline_session_id', None) or uuid.uuid4().hex
        self.session_boundary = 'native_sdk_pipeline_open' if backend.source == 'x5-hbn-sdk' and getattr(backend, 'pipeline_session_id', None) else 'unqualified_backend_instance'
        self.vendor_last_load = None
        self.dir = Path(config['stateDir']) / 'sdk-snapshots'
        self.dir.mkdir(mode=0o700, exist_ok=True)
        if self.dir.is_symlink() or self.dir.stat().st_mode & 0o077:
            raise ValueError('private_snapshot_directory_required')
        self.pointer = self.dir / 'current.json'
        self.current = private_json(self.pointer).get('snapshotId') if self.pointer.exists() else None
        self.policies = dict(config.get('ispFieldPolicies', {}))
        if config.get('awbGainLimits'):
            for field in ('rgain','grgain','gbgain','bgain'):
                self.policies.setdefault('awb.manual_attr.gain.'+field, config['awbGainLimits'])
        signatures = {
            'module_size': ([ctypes.c_int], ctypes.c_size_t),
            'module_name': ([ctypes.c_int], ctypes.c_char_p),
            'module_writable': ([ctypes.c_int], ctypes.c_int),
            'module_get': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t], ctypes.c_int),
            'module_set': ([ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t], ctypes.c_int),
            'module_normalize': ([ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t], ctypes.c_int),
            'module_field_count': ([ctypes.c_int], ctypes.c_int),
            'module_field_info': ([ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_int)], ctypes.c_int),
            'tuning_load': ([ctypes.c_void_p, ctypes.c_char_p], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(self.lib, 'x5w_' + name); fn.argtypes = args; fn.restype = result
        self.modules = {}
        for module_id in range(34):
            size = self.lib.x5w_module_size(module_id)
            name = self.lib.x5w_module_name(module_id)
            if not name or not 0 < size <= 1024 * 1024: raise error('isp_invalid_descriptor')
            name = name.decode('ascii'); fields = []
            for index in range(self.lib.x5w_module_field_count(module_id)):
                field = ctypes.create_string_buffer(200)
                offset, count = ctypes.c_size_t(), ctypes.c_size_t()
                kind, editable = ctypes.c_int(), ctypes.c_int()
                low, high = ctypes.c_double(), ctypes.c_double()
                backend.check(self.lib.x5w_module_field_info(module_id, index, field, len(field), ctypes.byref(offset), ctypes.byref(kind), ctypes.byref(count), ctypes.byref(low), ctypes.byref(high), ctypes.byref(editable)), 'isp_invalid_descriptor')
                if kind.value not in range(len(TYPES)) or not 0 < count.value <= 65536 or offset.value + struct.calcsize('=' + TYPES[kind.value]) * count.value > size:
                    raise error('isp_invalid_descriptor')
                key = field.value.decode('ascii'); policy = self.policies.get(name + '.' + key)
                lo, hi = (low.value, high.value) if math.isfinite(low.value) and math.isfinite(high.value) else (None, None)
                writable = bool(editable.value)
                origin = 'sdk-header'
                if name in ('exposure','awb','hdr_exposure') and (key=='mode' or key.startswith('manual_attr.')) and not config.get('modeReadbackEvidence',{}).get(name): writable=False
                if policy:
                    # Explicit operator policy cannot expand a published SDK range.
                    if lo is not None and (policy['min'] < lo or policy['max'] > hi): raise ValueError('isp_policy_expands_sdk_range')
                    lo, hi, writable, origin = policy['min'], policy['max'], True, 'operator-policy'
                if name in ('exposure','awb','hdr_exposure') and (key=='mode' or key.startswith('manual_attr.')) and not config.get('modeReadbackEvidence',{}).get(name): writable=False
                fields.append({'name': key, 'offset': offset.value, 'count': count.value, 'type': kind.value,
                    'min': lo, 'max': hi, 'editable': writable, 'boundsSource': origin,
                    **({'evidenceRef': policy['evidenceRef']} if policy else {})})
            self.modules[name] = {'id': module_id, 'size': size, 'writable': bool(self.lib.x5w_module_writable(module_id)), 'fields': fields}
        self.disabled_modules = config.get('disabledIspModules', {})
        for name, evidence in self.disabled_modules.items():
            if name not in self.modules or name in ('exposure','awb','cproc'):
                raise ValueError('invalid_disabled_isp_modules')
            module = self.modules[name]
            module.update(writable=False, excluded=evidence)
            for field in module['fields']: field['editable']=False
        # The configured subtraction is part of snapshot identity. Old or
        # broader snapshots cannot be replayed under this narrower capability.
        self.layout = digest(self.modules)

    def readback_scope(self):
        return 'configured_public_modules_partial' if self.disabled_modules else 'public_sdk_modules'

    def refresh_ae_limits(self):
        if not self.config.get('modeReadbackEvidence',{}).get('exposure'): return
        for descriptor in self.modules['exposure']['fields']:
            if descriptor.get('boundsSource','').startswith('actual_sdk_exposure_range'):
                policy=self.policies.get('exposure.'+descriptor['name'])
                descriptor.update(min=policy['min'] if policy else None,max=policy['max'] if policy else None,
                    editable=bool(policy),boundsSource='operator-policy' if policy else 'sdk-header')
        controls=self.backend.controls()
        for key,field in (('exposureUs','manual_attr.exp_time'),('gain','manual_attr.again')):
            row=controls.get(key)
            if not row: continue
            divisor=1e6 if key=='exposureUs' else 1
            low=ctypes.c_float(row['min']/divisor).value
            high=ctypes.c_float(row['max']/divisor).value
            policy=self.policies.get('exposure.'+field)
            if policy: low,high=max(low,policy['min']),min(high,policy['max'])
            if low>high: raise ValueError('isp_operator_policy_sdk_range_disjoint')
            for descriptor in self.modules['exposure']['fields']:
                if descriptor['name']==field:
                    descriptor.update(min=low,max=high,editable=bool(policy) or row['writable'] and row.get('active',True),
                        boundsSource='actual_sdk_exposure_range_and_operator_policy' if policy else 'actual_sdk_exposure_range')


    def get(self, module):
        buffer = ctypes.create_string_buffer(module['size'])
        self.backend.check(self.lib.x5w_module_get(self.backend.ctx, module['id'], buffer, len(buffer)), 'isp_module_readback_failed')
        return buffer.raw

    def normalized(self, module, raw):
        buffer = ctypes.create_string_buffer(raw, len(raw))
        self.backend.check(self.lib.x5w_module_normalize(module['id'], buffer, len(buffer)), 'isp_module_normalize_failed')
        return buffer.raw

    def values(self, module, raw):
        values = {}
        for field in module['fields']:
            items = list(struct.unpack_from('=' + TYPES[field['type']] * field['count'], raw, field['offset']))
            if not all(math.isfinite(value) for value in items): raise self.error('isp_nonfinite_readback')
            values[field['name']] = items[0] if field['count'] == 1 else items
        return values

    def load_snapshot(self, snapshot_id):
        if not isinstance(snapshot_id, str) or not re.fullmatch(r'[0-9a-f]{32}', snapshot_id): raise ValueError('isp_unknown_snapshot')
        saved = private_json(self.dir / (snapshot_id + '.json'))
        if saved.get('layoutHash') != self.layout or saved.get('sensorConfig') != self.config['sensorConfig'] or saved.get('sdkVersion') != self.config['sdkVersion'] or saved.get('csiPort')!=self.config['csiPort'] or saved.get('cameraMode')!=self.config['cameraMode']:
            raise ValueError('isp_snapshot_sdk_mismatch')
        return saved

    def snapshot(self, library=None):
        saved = {'layoutHash': self.layout, 'sensorConfig': self.config['sensorConfig'], 'sdkVersion': self.config['sdkVersion'], 'csiPort':self.config['csiPort'],'cameraMode':self.config['cameraMode'],'modules': {}}
        missing = []
        for name, module in self.modules.items():
            if name in self.disabled_modules:
                missing.append(name)
                continue
            if not module['writable']: continue
            try: raw = self.get(module)
            except self.error as exc:
                if getattr(exc, 'sdk_code', None) in (-95, -38): missing.append(name); continue
                raise
            saved['modules'][name] = base64.b64encode(raw).decode()
        if not {'exposure', 'awb', 'cproc'} <= set(saved['modules']): raise self.error('isp_core_module_readback_required')
        if library is not None:
            saved['library'] = base64.b64encode(library).decode()
            saved['librarySha256'] = hashlib.sha256(library).hexdigest()
        elif self.current:
            previous = self.load_snapshot(self.current)
            for key in ('library', 'librarySha256'):
                if key in previous: saved[key] = previous[key]
        else:
            # The pipeline selects the installed default library. Preserve its
            # bytes; this is declared file provenance, not an SDK filename getter.
            source = Path(self.config.get('effectLibrary', '/usr/hobot/lib/sensor/imx415_tuning.json'))
            try:
                blob = source.read_bytes()
                self.library_bytes(blob)
                saved.update(library=base64.b64encode(blob).decode(), librarySha256=hashlib.sha256(blob).hexdigest())
            except (OSError, ValueError): pass
        snapshot_id = uuid.uuid4().hex
        atomic_json(self.dir / (snapshot_id + '.json'), saved)
        self.current = snapshot_id
        atomic_json(self.pointer, {'snapshotId': snapshot_id})
        result = self.read()
        return result, missing

    def patched(self, name, original, values, allow_readonly=False):
        module = self.modules[name]
        fields = {field['name']: field for field in module['fields']}
        existing = self.values(module, self.normalized(module, original))
        if not isinstance(values, dict) or set(values) != set(fields): raise ValueError('complete_isp_module_values_required')
        out = bytearray(original)
        for key, value in values.items():
            field = fields[key]
            items = [value] if field['count'] == 1 else value
            if not isinstance(items, list) or len(items) != field['count'] or any(type(item) not in (int, float) or not math.isfinite(item) for item in items): raise ValueError('isp_invalid_module_field')
            changed = value != existing[key]
            if changed and not allow_readonly and not field['editable']: raise ValueError('isp_readonly_module_field')
            if changed and not allow_readonly and (field['min'] is None or any(not field['min'] <= item <= field['max'] for item in items)): raise ValueError('isp_module_field_out_of_range')
            try: packed = struct.pack('=' + TYPES[field['type']] * field['count'], *items)
            except (struct.error, OverflowError): raise ValueError('isp_module_field_encoding_invalid')
            if list(struct.unpack('=' + TYPES[field['type']] * field['count'], packed)) != items: raise ValueError('isp_module_field_quantization_required')
            out[field['offset']:field['offset'] + len(packed)] = packed
        return bytes(out)

    def prepare(self, tuning, recovering=False):
        self.refresh_ae_limits()
        if not isinstance(tuning, dict) or set(tuning) != {'kind','snapshotId','layoutHash','modules'} or tuning['kind'] != KIND or tuning['layoutHash'] != self.layout:
            raise ValueError('unsupported_isp_tuning_format')
        saved = self.load_snapshot(tuning['snapshotId'])
        if set(tuning['modules']) != set(saved['modules']): raise ValueError('complete_isp_snapshot_required')
        return saved, {name: self.patched(name, base64.b64decode(raw, validate=True), tuning['modules'][name], recovering) for name, raw in saved['modules'].items()}

    def read(self, expected=None):
        if not self.current:
            return self.snapshot()[0]
        anchor = expected or {'snapshotId': self.current}
        saved = self.load_snapshot(anchor['snapshotId']); values = {}; actual = {}
        for name, raw in saved['modules'].items():
            module = self.modules[name]; got = self.get(module); actual[name] = got
            normalized = self.normalized(module, got)
            values[name] = self.values(module, normalized)
            wanted = self.patched(name, base64.b64decode(raw, validate=True), values[name], True)
            if self.normalized(module, wanted) != normalized: raise self.error('isp_unexposed_configuration_changed')
        config = {'kind': KIND, 'snapshotId': anchor['snapshotId'], 'layoutHash': self.layout, 'modules': values}
        if expected:
            _saved, wanted = self.prepare(expected, True)
            for name in wanted:
                if self.normalized(self.modules[name], wanted[name]) != self.normalized(self.modules[name], actual[name]): raise self.error('isp_module_readback_mismatch')
            if self.digest(config) != self.digest(expected): raise self.error('isp_readback_mismatch')
        return config

    def baseline(self):
        self.refresh_ae_limits()
        config = self.read(); rules = []
        for name, fields in config['modules'].items():
            module = self.modules[name]
            for field in module['fields']:
                if field['editable'] and field['name'] not in ('mode','configMode','module.u32Key') and field['count'] == 1 and field['min'] is not None and not (field['name'].startswith('manual_attr.') and fields.get('mode')==0):
                    value = fields[field['name']]
                    if field['min'] <= value <= field['max']:
                        rules.append({'path': '/modules/' + name + '/' + field['name'], 'label': name + '.' + field['name'], 'min': field['min'], 'max': field['max'],
                            **({'precision': 'float32'} if field['type'] == 2 else {'step': 1} if field['type'] in (0,1,3,4,5,6) else {})})
        return {'config': config, 'rules': rules[:128]}

    def declared_library_matches(self, tuning):
        saved = self.load_snapshot(tuning['snapshotId'])
        expected = saved.get('librarySha256')
        if not expected: return False
        # A restarted pipeline chooses the installed default. The old archive
        # pointer alone cannot establish that those declared bytes stayed equal.
        source = Path(self.config.get('effectLibrary', '/usr/hobot/lib/sensor/imx415_tuning.json'))
        try: return hashlib.sha256(source.read_bytes()).hexdigest() == expected
        except OSError: return False

    def write_intent(self, tuning, recovering=False, recovery_scope=None, restarted=False):
        saved = self.load_snapshot(tuning['snapshotId'])
        current_saved = self.load_snapshot(self.current) if self.current else {}
        # Only the camera's durable journal supplies recovery_scope. Missing
        # legacy intent must conservatively recover the complete effect library.
        if recovering and recovery_scope not in ('modules', 'library'):
            recovery_scope = 'library'
        different_library = saved.get('librarySha256') != current_saved.get('librarySha256')
        uncertain_restart = recovering and restarted and not self.declared_library_matches(tuning)
        return 'library' if different_library or uncertain_restart or recovering and recovery_scope == 'library' else 'modules'

    def apply(self, tuning, *, intent):
        if intent not in ('modules', 'library'): raise ValueError('isp_invalid_write_intent')
        saved, wanted = self.prepare(tuning)
        # A module-only caller may not silently switch a library after its
        # pending journal was persisted. Resolve and journal intent before apply.
        if intent == 'modules' and self.write_intent(tuning) != 'modules':
            raise ValueError('isp_library_restore_required')
        if intent == 'library':
            if not saved.get('library'): raise ValueError('isp_original_effect_library_unavailable')
            self.load_library(base64.b64decode(saved['library'], validate=True))
        for name, raw in wanted.items():
            module = self.modules[name]
            if self.normalized(module, self.get(module)) == self.normalized(module, raw): continue
            buffer = ctypes.create_string_buffer(raw, len(raw))
            self.backend.check(self.lib.x5w_module_set(self.backend.ctx, module['id'], buffer, len(buffer)), 'isp_module_write_failed')
            if self.normalized(module, self.get(module)) != self.normalized(module, raw): raise self.error('isp_module_readback_mismatch')
        actual = self.read(tuning)
        self.current = tuning['snapshotId']; atomic_json(self.pointer, {'snapshotId': self.current})
        return actual

    @staticmethod
    def library_bytes(blob):
        if not isinstance(blob, bytes) or not 0 < len(blob) <= MAX_LIBRARY: raise ValueError('isp_effect_library_size_invalid')
        try: parsed = json.loads(blob, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError): raise ValueError('isp_effect_library_json_invalid')
        if not isinstance(parsed, dict) or not parsed: raise ValueError('isp_effect_library_json_invalid')
        return blob

    def load_library(self, blob, require_candidate=False):
        self.library_bytes(blob)
        self.vendor_last_load = None
        # Generated artifacts have a private, server-created receipt. Legacy
        # library inputs retain their old contract and acquire no export proof.
        candidate = self.validate_vendor_candidate(blob) if require_candidate else None
        # SDK has a short path limit. Only this daemon creates the SDK argument.
        fd, name = tempfile.mkstemp(prefix='x5isp-', suffix='.json', dir='/tmp')
        try:
            with os.fdopen(fd, 'wb') as out: out.write(blob); out.flush(); os.fsync(out.fileno())
            self.backend.check(self.lib.x5w_tuning_load(self.backend.ctx, name.encode()), 'isp_effect_library_load_failed')
            self.scene_generation += 1
            if candidate:
                # A successful scene call is not a readback. Check every
                # normalized public configuration field against the source.
                actual = self.read(candidate['sourceConfig'])
                if self.digest(actual['modules']) != candidate['sourceModulesSha256']: raise self.error('vendor_candidate_readback_mismatch')
                self.vendor_last_load = {'candidateSha256': candidate['sha256'], 'bindingHash': candidate['bindingHash'], 'sourceReadbackHash': candidate['sourceReadbackHash'],
                    'actualReloadReadbackHash': self.digest(actual), 'actualReloadModulesSha256': self.digest(actual['modules']),
                    'validationScope': self.readback_scope() + '_normalized_selected_mode_configuration',
                    'exportSessionId': candidate['exportSessionId'], 'reloadSessionId': self.session_id, 'sessionBoundary': self.session_boundary,
                    'freshSessionObserved': candidate['exportSessionId'] != self.session_id and candidate.get('exportSessionBoundary') == 'native_sdk_pipeline_open' and self.session_boundary == 'native_sdk_pipeline_open',
                    'sdkCall': 'hbn_camera_switch_scence', 'moduleReadback': 'independent_hbn_isp_get_after_library_load',
                    'modeQualifications': {key: 'private_evidence_configured' if self.config.get('modeReadbackEvidence', {}).get(key) else 'qualification_required' for key in ('exposure', 'awb', 'hdr_exposure') if key in candidate['sourceConfig']['modules']},
                    'source': self.backend.source, 'hardwareVerification': 'unverified', 'qualityVerification': 'unverified'}
                return self.vendor_last_load.copy()
        finally: Path(name).unlink(missing_ok=True)

    def vendor_directory(self):
        directory = self.dir / 'vendor-candidates'
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('private_vendor_candidate_directory_required')
        return directory

    @staticmethod
    def vendor_document(blob):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result: raise ValueError('vendor_export_template_invalid')
                result[key] = value
            return result
        try: document = json.loads(blob, object_pairs_hook=unique, parse_constant=lambda _x: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError): raise ValueError('vendor_export_template_invalid') from None
        if not isinstance(document, dict) or not document: raise ValueError('vendor_export_template_invalid')
        pending, visited = [(document, 0)], 0
        while pending:
            value, depth = pending.pop(); visited += 1
            if depth > 32 or visited > 1_000_000: raise ValueError('vendor_export_template_invalid')
            if isinstance(value, dict): pending.extend((row, depth + 1) for row in value.values())
            elif isinstance(value, list): pending.extend((row, depth + 1) for row in value)
            elif type(value) in (int, float) and not finite_number(value): raise ValueError('vendor_export_nonfinite')
        return document

    @staticmethod
    def vendor_target(document, parts):
        current = document
        for index, part in enumerate(parts):
            if isinstance(current, list):
                if not re.fullmatch(r'0|[1-9][0-9]*', part) or len(part) > 8 or int(part) >= len(current): raise ValueError('vendor_export_existing_numeric_target_required')
                key = int(part)
            elif isinstance(current, dict) and part in current: key = part
            else: raise ValueError('vendor_export_existing_numeric_target_required')
            if index == len(parts) - 1: return current, key
            current = current[key]
        raise ValueError('vendor_export_existing_numeric_target_required')

    @staticmethod
    def vendor_numeric_shape(value):
        if finite_number(value): return 'number'
        if isinstance(value, list) and value: return [Isp.vendor_numeric_shape(row) for row in value]
        raise ValueError('vendor_export_existing_numeric_target_required')

    def vendor_base(self, actual, binding, base_id=None):
        binding_hash = self.digest(binding)
        if base_id is None:
            anchor = self.vendor_directory() / ('binding-' + binding_hash + '.json')
            base_id = private_json(anchor)['snapshotId'] if anchor.exists() or anchor.is_symlink() else actual['snapshotId']
        saved = self.load_snapshot(base_id)
        if 'library' not in saved: raise ValueError('vendor_export_original_library_required')
        try: template = base64.b64decode(saved['library'], validate=True)
        except (ValueError, TypeError): raise ValueError('vendor_export_template_invalid') from None
        if hashlib.sha256(template).hexdigest() != binding['templateSha256'] or saved.get('librarySha256') != binding['templateSha256']:
            raise ValueError('vendor_export_template_mismatch')
        baseline = {name: self.values(self.modules[name], self.normalized(self.modules[name], base64.b64decode(raw, validate=True))) for name, raw in saved['modules'].items()}
        if self.digest(baseline) != binding['baselineModulesSha256']: raise ValueError('vendor_export_baseline_mismatch')
        return base_id, template, baseline

    def render_vendor_candidate(self, actual, binding, base_id=None):
        validate_export_binding(binding, self.config)
        if binding['layoutHash'] != self.layout or actual['layoutHash'] != self.layout: raise ValueError('vendor_export_layout_mismatch')
        base_id, template, baseline = self.vendor_base(actual, binding, base_id)
        if set(actual['modules']) != set(baseline): raise ValueError('vendor_export_module_scope_mismatch')
        changed = set()
        for name, fields in actual['modules'].items():
            if set(fields) != set(baseline[name]): raise ValueError('vendor_export_module_scope_mismatch')
            changed.update((name, field) for field, value in fields.items() if value != baseline[name][field])
        mapped = {(row['module'], row['field']) for row in binding['mappings']}
        if not changed <= mapped: raise ValueError('vendor_export_unmapped_modified_field')
        document = self.vendor_document(template)
        for row in binding['mappings']:
            name, key = row['module'], row['field']
            if name not in actual['modules'] or key not in actual['modules'][name]: raise ValueError('vendor_export_source_field_unavailable')
            descriptor = next((field for field in self.modules[name]['fields'] if field['name'] == key), None)
            if descriptor is None: raise ValueError('vendor_export_source_field_unavailable')
            value = actual['modules'][name][key]
            source = value if isinstance(value, list) else [value]
            if len(source) != descriptor['count'] or any(not finite_number(item) for item in source): raise ValueError('vendor_export_source_invalid')
            if descriptor['min'] is not None and any(not descriptor['min'] <= item <= descriptor['max'] for item in source): raise ValueError('vendor_export_source_out_of_range')
            if descriptor['count'] > 1 and 'shape' not in row: raise ValueError('vendor_export_array_layout_required')
            if 'shape' in row and math.prod(row['shape']) != descriptor['count']: raise ValueError('vendor_export_array_layout_invalid')
            encoded = []
            for item in source:
                number = item * row.get('scale', 1)
                if not math.isfinite(number): raise ValueError('vendor_export_nonfinite')
                if row['encoding'] == 'integer': number = round(number)
                elif row['encoding'] == 'float32': number = ctypes.c_float(number).value
                if not math.isfinite(number) or not row['min'] <= number <= row['max']: raise ValueError('vendor_export_out_of_range')
                encoded.append(number)
            if 'shape' in row:
                ordered = iter(encoded[index] for index in row['order'])
                def shaped(dimensions):
                    return [next(ordered) for _ in range(dimensions[0])] if len(dimensions) == 1 else [shaped(dimensions[1:]) for _ in range(dimensions[0])]
                output = shaped(row['shape'])
            else: output = encoded[0]
            target, target_key = self.vendor_target(document, pointer_parts(row['jsonPointer']))
            if self.vendor_numeric_shape(target[target_key]) != self.vendor_numeric_shape(output): raise ValueError('vendor_export_target_shape_mismatch')
            target[target_key] = output
        blob = json.dumps(document, allow_nan=False, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        if len(blob) > MAX_LIBRARY: raise ValueError('vendor_export_output_limit')
        return blob, base_id, sorted(name + '.' + field for name, field in changed)

    def vendor_candidate(self, actual):
        binding = self.config.get('effectLibraryExportBinding')
        required = {'artifactRole': 'vendor_effect_library_candidate', 'hardwareVerification': 'unverified', 'qualityVerification': 'unverified', 'targetValidation': 'sdk_load_independent_readback_and_fresh_frame_required'}
        if not binding: return {**required, 'status': 'blocked', 'reason': 'vendor_export_binding_required'}
        try:
            blob, base_id, changed = self.render_vendor_candidate(actual, binding)
            checksum = hashlib.sha256(blob).hexdigest()
            record = {'schema': 'x5-vendor-candidate-receipt-v1', 'sha256': checksum, 'bytes': len(blob), 'bindingHash': self.digest(binding), 'baseSnapshotId': base_id,
                'profile': {key: self.config[key] for key in EXPORT_PROFILE}, 'layoutHash': self.layout, 'sourceConfig': actual,
                'sourceModulesSha256': self.digest(actual['modules']), 'sourceReadbackHash': self.digest(actual),
                'exportSessionId': self.session_id, 'exportSessionBoundary': self.session_boundary}
            directory = self.vendor_directory()
            atomic_json(directory / ('binding-' + self.digest(binding) + '.json'), {'snapshotId': base_id})
            receipt_file = directory / (checksum + '.json')
            if receipt_file.exists() or receipt_file.is_symlink():
                previous = private_json(receipt_file)
                if all(previous.get(key) == record[key] for key in ('schema', 'sha256', 'bytes', 'bindingHash', 'baseSnapshotId', 'profile', 'layoutHash', 'sourceModulesSha256')):
                    record = previous  # Preserve the original generating pipeline boundary.
            atomic_json(receipt_file, record)
            reloaded = directory / (checksum + '.reload.json')
            validation = private_json(reloaded) if reloaded.exists() or reloaded.is_symlink() else None
            if validation and any(validation.get(key) != record[key] for key in ('bindingHash', 'sourceReadbackHash')): validation = None
            return {**required, 'status': 'generated_requires_target_validation', 'filename': 'imx415-vendor-candidate.json', 'mimeType': 'application/json',
                'contentBase64': base64.b64encode(blob).decode(), 'sha256': checksum, 'bytes': len(blob), 'modifiedFields': changed,
                'bindingHash': self.digest(binding), 'templateSha256': binding['templateSha256'], 'baselineModulesSha256': binding['baselineModulesSha256'],
                'sourceModulesSha256': record['sourceModulesSha256'], 'sourceReadbackHash': record['sourceReadbackHash'],
                'coverageScope': 'all_modified_normalized_sdk_readable_configuration_fields', 'loadValidation': 'private_receipt_binding_regeneration_and_fresh_getters',
                **({'targetValidation': 'target_reload_recorded', 'reloadValidation': validation} if validation else {})}
        except ValueError as exc:
            # Error codes contain no private paths, mappings or raw native data.
            reason = str(exc) if str(exc).startswith('vendor_export_') else 'vendor_export_validation_failed'
            return {**required, 'status': 'blocked', 'reason': reason}

    def validate_vendor_candidate(self, blob, required=True):
        checksum = hashlib.sha256(blob).hexdigest()
        directory = self.dir / 'vendor-candidates'
        receipt = directory / (checksum + '.json')
        if not receipt.exists() and not receipt.is_symlink():
            if required: raise ValueError('vendor_candidate_receipt_required')
            return None
        self.vendor_directory()
        record = private_json(receipt)
        binding = self.config.get('effectLibraryExportBinding')
        expected_keys = {'schema', 'sha256', 'bytes', 'bindingHash', 'baseSnapshotId', 'profile', 'layoutHash', 'sourceConfig', 'sourceModulesSha256', 'sourceReadbackHash', 'exportSessionId', 'exportSessionBoundary'}
        if not isinstance(record, dict) or set(record) != expected_keys or not isinstance(record.get('sourceConfig'), dict) or any(not isinstance(record.get(key), str) or not re.fullmatch('[a-f0-9]{64}', record[key]) for key in ('bindingHash', 'sourceModulesSha256', 'sourceReadbackHash')) or not isinstance(record.get('exportSessionId'), str) or not re.fullmatch('[a-f0-9]{32}', record['exportSessionId']) or record.get('exportSessionBoundary') not in ('native_sdk_pipeline_open', 'unqualified_backend_instance'):
            raise ValueError('vendor_candidate_receipt_invalid')
        if not binding or record.get('schema') != 'x5-vendor-candidate-receipt-v1' or record.get('bindingHash') != self.digest(binding): raise ValueError('vendor_candidate_binding_mismatch')
        if record.get('sha256') != checksum or record.get('bytes') != len(blob) or record.get('layoutHash') != self.layout or record.get('profile') != {key: self.config[key] for key in EXPORT_PROFILE}:
            raise ValueError('vendor_candidate_identity_mismatch')
        actual = self.read()  # Independent current getters must work before a write.
        if actual['layoutHash'] != record['layoutHash'] or set(actual['modules']) != set(record['sourceConfig']['modules']): raise ValueError('vendor_candidate_module_scope_mismatch')
        regenerated, _base_id, _changed = self.render_vendor_candidate(record['sourceConfig'], binding, record['baseSnapshotId'])
        if regenerated != blob or self.digest(record['sourceConfig']['modules']) != record['sourceModulesSha256'] or self.digest(record['sourceConfig']) != record['sourceReadbackHash']:
            raise ValueError('vendor_candidate_content_mismatch')
        self.prepare(record['sourceConfig'], True)
        return record

    def record_vendor_reload(self, blob, receipt, stream):
        """Called only after the wrapper obtained a fresh valid stream frame."""
        if not receipt or receipt != self.vendor_last_load or receipt.get('candidateSha256') != hashlib.sha256(blob).hexdigest() or not isinstance(stream, dict) or stream.get('status') != 'verified':
            raise ValueError('vendor_candidate_fresh_frame_required')
        record = private_json(self.vendor_directory() / (receipt['candidateSha256'] + '.json'))
        if receipt.get('bindingHash') != record['bindingHash'] or receipt.get('sourceReadbackHash') != record['sourceReadbackHash'] or receipt.get('actualReloadModulesSha256') != record['sourceModulesSha256']:
            raise ValueError('vendor_candidate_reload_receipt_mismatch')
        actual = self.read()
        if self.digest(actual['modules']) != record['sourceModulesSha256']: raise self.error('vendor_candidate_readback_mismatch')
        validation = {**receipt, 'actualReloadReadbackHash': self.digest(actual), 'status': 'target_reload_recorded', 'streamVerification': stream,
            'unexposedLibraryFieldsReadback': False, 'qualityVerification': 'unverified'}
        atomic_json(self.vendor_directory() / (receipt['candidateSha256'] + '.reload.json'), validation)
        return validation

    def export(self):
        actual = self.read(); saved = self.load_snapshot(actual['snapshotId'])
        return {'config': actual, 'readbackHash': self.digest(actual), 'format': KIND,
            'artifactRole': 'sdk_configuration_with_archived_declared_library', 'independentlyDeployable': False,
            'archivedLibraryRole': 'previously_declared_input_not_current_module_export',
            'vendorCandidate': self.vendor_candidate(actual),
            'observations': self.observations(),
            'excludedModules': self.disabled_modules,
            'librarySha256': saved.get('librarySha256'),
            **({'contentBase64': saved['library'], 'sha256': saved['librarySha256'], 'filename': 'imx415-effect.json', 'mimeType': 'application/json'} if 'library' in saved else {}),
            'evidence': {'source': self.backend.source, 'moduleReadback': 'independent_hbn_isp_get', 'libraryBytes': 'archived_declared_input', 'hardwareAcceptance': 'unverified',
                         'libraryReadbackScope': 'public_sdk_modules_only', 'moduleReadbackScope': self.readback_scope(),
                         'unexposedLibraryFieldsReadback': False}}

    def observations(self):
        """Actual read-only SDK bytes; volatile diagnostics stay outside config hash."""
        observed = {}
        for name, module in self.modules.items():
            if module['writable']: continue
            evidence = {'source': self.backend.source, 'sizeBytes': module['size'],
                        'interpretation': 'sdk_diagnostic_bytes_not_image_quality_validation'}
            if name in self.disabled_modules:
                evidence.update(excludedFromSnapshot=True, exclusionEvidence=self.disabled_modules[name])
            try:
                raw = self.normalized(module, self.get(module))
                observed[name] = {**evidence, 'status': 'observed',
                    'normalizedSha256': hashlib.sha256(raw).hexdigest(), 'knownValues': self.values(module, raw)}
            except self.error as exc:
                observed[name] = {**evidence, 'status': 'unavailable',
                    **({'sdkCode': exc.sdk_code} if getattr(exc,'sdk_code',None) is not None else {})}
        return observed

    def map_calibration(self, result, options):
        """Map owned CPU results to the configured SDK schema, never infer one."""
        if not isinstance(result, dict) or result.get('schema') != 'rdk.x5-calibration-result.v1' or result.get('status') != 'computed' or not isinstance(options, dict):
            raise ValueError('calibration_result_invalid')
        operation = result.get('operation')
        binding = self.config.get('calibrationBindings', {}).get(operation)
        if not binding or not isinstance(binding.get('evidenceRef'), str): raise ValueError('calibration_sdk_binding_required')
        values = result['parameters']['values']
        tuning = self.read()
        if binding.get('target') == 'effect-library':
            saved = self.load_snapshot(tuning['snapshotId'])
            if 'library' not in saved: raise ValueError('isp_original_effect_library_unavailable')
            document = json.loads(base64.b64decode(saved['library'], validate=True))
            mappings = binding.get('mappings', [])
            if not mappings: raise ValueError('calibration_sdk_binding_required')
            for mapping in mappings:
                source = values
                for component in mapping['resultPath']:
                    source = source[component] if isinstance(source, dict) else source[int(component)]
                def convert(value):
                    if isinstance(value, list): return [convert(v) for v in value]
                    if isinstance(value, dict): raise ValueError('calibration_scalar_or_array_required')
                    if type(value) not in (int,float) or not math.isfinite(value): raise ValueError('calibration_value_invalid')
                    encoded = value * mapping.get('scale', 1)
                    if mapping.get('encoding') == 'integer': encoded = round(encoded)
                    elif mapping.get('encoding') == 'float32': encoded = ctypes.c_float(encoded).value
                    if not mapping['min'] <= encoded <= mapping['max']: raise ValueError('calibration_sdk_range_invalid')
                    return encoded
                parts = mapping['jsonPointer'].split('/')[1:]
                if not parts or any(part in ('__proto__','prototype','constructor') for part in parts): raise ValueError('calibration_sdk_binding_invalid')
                target = document
                for part in parts[:-1]:
                    key = part.replace('~1','/').replace('~0','~')
                    target = target[int(key)] if isinstance(target,list) else target[key]
                key = parts[-1].replace('~1','/').replace('~0','~')
                key = int(key) if isinstance(target,list) else key
                if isinstance(target, dict) and key not in target: raise ValueError('calibration_existing_sdk_field_required')
                converted = convert(source)
                existing = target[key]
                def shape(value): return [shape(v) for v in value] if isinstance(value,list) else 'number' if type(value) in (int,float) else 'other'
                if shape(existing) != shape(converted): raise ValueError('calibration_sdk_shape_mismatch')
                target[key] = converted
            return {'library': json.dumps(document,allow_nan=False,separators=(',',':')).encode(), 'evidence': {'binding': binding['evidenceRef'], 'operation':operation, 'fullFieldReadbackAvailable':False}}
        module_name = binding.get('module')
        if module_name not in tuning['modules']: raise ValueError('calibration_sdk_module_unavailable')
        module = self.modules[module_name]; fields = {f['name']:f for f in module['fields']}; destination = tuning['modules'][module_name]
        patch = {}
        if operation == 'ccm':
            if binding.get('matrixOrder') not in ('row-major','column-major'): raise ValueError('calibration_matrix_order_required')
            matrix = values if binding['matrixOrder']=='row-major' else [list(row) for row in zip(*values)]
            patch[binding['field']] = [v for row in matrix for v in row]
        elif operation == 'awb':
            if set(options) != {'illuminantId'}: raise ValueError('calibration_illuminant_selection_required')
            rows = [v for v in values if v['illuminantId']==options['illuminantId']]
            if len(rows)!=1: raise ValueError('calibration_illuminant_unknown')
            selected = rows[0]
            for field, channel in binding['gainFields'].items():
                patch[field] = selected[channel]
        elif operation == 'lsc':
            xs, ys = binding.get('xPositionsNormalized'), binding.get('yPositionsNormalized')
            order = binding.get('channelOrder')
            if not isinstance(xs,list) or not isinstance(ys,list) or sorted(order or []) != sorted(values): raise ValueError('calibration_lsc_geometry_required')
            if any(type(v) not in (int,float) or not 0<=v<=1 for v in xs+ys) or xs!=sorted(set(xs)) or ys!=sorted(set(ys)): raise ValueError('calibration_lsc_geometry_invalid')
            source_x = result['parameters']['grid']['xCentersNormalized']; source_y = result['parameters']['grid']['yCentersNormalized']
            def bracket(grid, x):
                if x<=grid[0]: return 0,0,0
                if x>=grid[-1]: return len(grid)-1,len(grid)-1,0
                for i in range(len(grid)-1):
                    if grid[i]<=x<=grid[i+1]: return i,i+1,(x-grid[i])/(grid[i+1]-grid[i])
                raise ValueError('calibration_lsc_geometry_invalid')
            target=[]
            for channel in order:
                grid=values[channel]
                for y in ys:
                    a,b,t=bracket(source_y,y)
                    for x in xs:
                        c,d,u=bracket(source_x,x)
                        target.append(round(((1-t)*((1-u)*grid[a][c]+u*grid[a][d])+t*((1-u)*grid[b][c]+u*grid[b][d])) * binding['unityCode']))
            patch[binding['field']]=target
        else: raise ValueError('calibration_native_module_binding_unavailable')
        if 'modeField' in binding: patch[binding['modeField']]=binding['modeValue']
        for field, value in patch.items():
            if field not in fields: raise ValueError('calibration_sdk_binding_invalid')
            descriptor=fields[field]
            def quantize(v):
                return ctypes.c_float(v).value if descriptor['type']==2 else v
            destination[field]=[quantize(v) for v in value] if isinstance(value,list) else quantize(value)
        self.prepare(tuning)
        return {'tuning':tuning,'evidence':{'binding':binding['evidenceRef'],'operation':operation,'readback':'independent_sdk_module_get','qualityVerification':'unverified'}}
