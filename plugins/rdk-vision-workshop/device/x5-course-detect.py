#!/usr/bin/env python3
"""Run the course model on a qualified X5 camera adapter in an exclusive session."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import statistics
import sys
import time

CLASSES = ('park', 'qrcode', 'obstacle')
OUTPUT_NAMES = ('output0', '326', '334', '342', '350', '358')
OUTPUT_SHAPES = [(1, size, size, channels) for size in (80, 40, 20) for channels in (3, 64)]


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def model_binding(profile_path, model_path):
    profile = json.loads(profile_path.read_text())
    digest = sha256(model_path.read_bytes())
    heads = profile['decoder']['heads']
    if (profile['sha256'] != digest or tuple(profile['classes']) != CLASSES
            or tuple(head['name'] for head in heads) != OUTPUT_NAMES
            or [tuple(head['shape']) for head in heads] != OUTPUT_SHAPES
            or profile['architecture'] != 'bayes-e'
            or profile['input']['resize'] != 'direct'
            or (profile['input']['width'], profile['input']['height'], profile['input']['type']) != (640, 640, 'NV12')):
        raise ValueError('model_profile_mismatch')
    return digest


def preview_bgr(camera, data, info, cv2, np):
    height, width = info['height'], info['width']
    raw = np.frombuffer(data, dtype=np.uint8)
    y = raw[:info['size_y']].reshape(height, info['stride_y'])[:, :width]
    uv = raw[info['size_y']:].reshape(height // 2, info['stride_uv'])[:, :width].reshape(height // 2, width // 2, 2)
    y_small = cv2.resize(y, (960, 540), interpolation=cv2.INTER_AREA)
    uv_small = cv2.resize(uv, (480, 270), interpolation=cv2.INTER_AREA)
    png = camera.frame_tools.nv12_to_png(y_small.tobytes(), uv_small.tobytes(), width=960, height=540,
        y_stride=960, uv_stride=960, matrix=camera.config['colorMatrix'], color_range=camera.config['colorRange'], compression_level=1)
    return cv2.imdecode(np.frombuffer(png, dtype=np.uint8), cv2.IMREAD_COLOR)


def archive_frame(camera, output, prefix, expected_hash):
    frame = camera.execute('capture_frame', {'scene': '课堂 Gamma ' + prefix})
    content = base64.b64decode(frame['contentBase64'], validate=True)
    if sha256(content) != frame['sha256'] or frame['tuningHash'] != expected_hash:
        raise RuntimeError('camera_archive_configuration_mismatch')
    name = prefix + '.png'
    (output / name).write_bytes(content)
    return {'file': name, 'sha256': frame['sha256'], 'width': frame['width'], 'height': frame['height'],
            'tuningHash': expected_hash, 'sdkTimestampNs': frame['evidence']['sdkTimestampNs']}


def main(args):
    if platform.machine() != 'aarch64':
        raise RuntimeError('x5_aarch64_runtime_required')
    import cv2
    import numpy as np
    model_sha = model_binding(args.profile, args.model)
    effect = args.effect.read_bytes() if args.effect else None
    if effect is not None and sha256(effect) != args.effect_sha256:
        raise ValueError('isp_candidate_sha256_mismatch')
    native = load_module('course_vision_x5_camera', args.camera_module)
    native_config = native.read_private_json(args.camera_config)
    environment = native.gpio_permission_environment(native_config)
    if environment is not None:
        os.execve(sys.executable, [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], environment)
    candidate_builder = None
    if args.gamma_toolkit:
        if native_config.get('sensorModel') != 'IMX415' or '3840x2160-linear-RAW10' not in native_config.get('cameraMode', ''):
            raise RuntimeError('gamma_profile_mismatch')
        # The package helper independently validates the live, monotone 20×64 AUTO table.
        # Keep the installed private configuration unchanged. This qualification is for this session.
        native_config = dict(native_config)
        policies = dict(native_config.get('ispFieldPolicies', {}))
        policies.setdefault('gamma.auto_attr.curve', {'min': 0, 'max': 1023,
            'evidenceRef': 'X5 IMX415 common AUTO table and independent SDK readback, formal Gamma acceptance 2026-10-20'})
        native_config['ispFieldPolicies'] = policies
        prior_journal=Path(native_config['stateDir'])/'isp-write.json'
        if prior_journal.exists():
            prior=native.read_private_json(prior_journal)
            if prior.get('cleanupRequired') or prior.get('outcome') in ('pending','unconfirmed','confirmed'):
                raise RuntimeError('previous_camera_recovery_required')
        # A newly qualified field changes the ISP layout hash. Use a separate durable
        # SDK journal so the installed adapter's private snapshots remain intact.
        native_config['stateDir']=str(args.output.with_name(args.output.name+'-sdk-state'))
        sys.path.insert(0, str(args.gamma_toolkit))
        from x5_gamma_tuning_candidate import tuning_candidate as candidate_builder
    sys.path.insert(0, str(args.model_zoo))
    zoo = load_module('ultralytics_yolo_det', args.model_zoo/'ultralytics_yolo_det.py')
    detector = zoo.UltralyticsYOLODetect(zoo.UltralyticsYOLODetectConfig(
        model_path=str(args.model), classes_num=3, resize_type=0, score_thres=.25, nms_thres=.70))
    detector.set_scheduling_params(priority=0, bpu_cores=[0])
    if (detector.input_w, detector.input_h) != (640, 640) or tuple(detector.output_names) != OUTPUT_NAMES:
        raise RuntimeError('bpu_runtime_tensor_mismatch')

    def infer(image):
        tensor = detector.pre_process(image)
        start = time.monotonic()
        outputs = detector.forward(tensor)
        elapsed = (time.monotonic() - start) * 1000
        actual = outputs[detector.model_name]
        if any(tuple(actual[name].shape) != shape or not np.isfinite(actual[name]).all()
               for name, shape in zip(OUTPUT_NAMES, OUTPUT_SHAPES)):
            raise RuntimeError('bpu_runtime_head_mismatch')
        boxes, scores, ids = detector.post_process(outputs, image.shape[1], image.shape[0])
        detections = []
        for box, score, ident in zip(boxes, scores, ids):
            label = CLASSES[int(ident)]
            x1, y1, x2, y2 = map(int, box)
            cv2.rectangle(image, (x1,y1), (x2,y2), (14,205,62), 2)
            cv2.putText(image, f'{label} {score:.2f}', (max(0,x1),max(15,y1-5)),
                        cv2.FONT_HERSHEY_SIMPLEX, .5, (14,205,62), 2)
            detections.append({'class':label,'score':float(score),'box':[x1,y1,x2,y2]})
        return detections, elapsed

    args.output.mkdir(mode=0o700, exist_ok=False)
    report = {'schema':'rdk.vision-course-board.v1','modelSha256':model_sha,'effectSha256':args.effect_sha256,'classes':CLASSES,
              'status':'started','stage':'model_loaded','restoration':'not_run','frames':[], 'phases':{}}
    report_file = args.output/'receipt.json'
    write_json(report_file, report)
    static = cv2.imread(str(args.static_image))
    if static is None:
        raise ValueError('static_image_unreadable')
    findings, ms = infer(static)
    if not cv2.imwrite(str(args.output/'static-detection.jpg'), static):
        raise RuntimeError('static_evidence_write_failed')
    report['staticBpu'] = {'detections':findings,'forwardMs':ms,
                           'imageSha256':sha256(args.static_image.read_bytes())}
    report['stage']='static_bpu_verified';write_json(report_file,report)
    camera = native.Camera(native_config)
    if camera.unconfirmed or camera.cleanup_required or camera.changed:
        report.update(status='failed', failure='previous_camera_recovery_required')
        write_json(report_file, report)
        if camera.backend:
            camera.backend.close()
        raise RuntimeError('previous_camera_recovery_required')
    original = None
    wrote_configuration = False
    try:
        if camera.config['sensorModel'].lower() != 'imx415':
            raise RuntimeError('imx415_required')
        camera.start()
        report['cameraIdentity'] = camera.identity()
        original = camera.execute('tuning_get',{})
        write_json(args.output/'original-isp.json',original)
        report['ispSnapshots']={'original-isp.json':sha256((args.output/'original-isp.json').read_bytes())}
        timestamp = 0
        def collect(phase, expected_hash, duration):
            nonlocal timestamp
            start=time.monotonic()
            first=len(report['frames'])
            report['stage']=phase;write_json(report_file,report)
            next_preview=0
            while time.monotonic()-start < duration:
                row = infer_frame(phase, expected_hash, timestamp)
                timestamp=int(row['sdkTimestampNs'])
                report['frames'].append(row)
                if time.monotonic()>next_preview:
                    write_json(report_file,report)
                    next_preview=time.monotonic()+0.5
            if len(report['frames'])==first:
                raise RuntimeError('no_live_frames')
            rows=report['frames'][first:]
            findings=[d for row in rows for d in row['detections'] if d['class']=='qrcode']
            report['phases'][phase]={'frames':len(rows),'qrcodeFrames':sum(any(d['class']=='qrcode' for d in row['detections']) for row in rows),
                'bestQrcodeScore':max((d['score'] for d in findings),default=None),
                'medianForwardMs':statistics.median(row['forwardMs'] for row in rows), 'processingFps':len(rows)/(time.monotonic()-start)}

        def infer_frame(phase, expected_hash, cursor):
            begin = time.monotonic()
            with camera.lock:
                if camera.cleanup_required or camera.unconfirmed:
                    raise RuntimeError('camera_state_unconfirmed')
                active = camera.full_isp().digest(camera.configuration(camera.controls()))
                if active != expected_hash:
                    raise RuntimeError('isp_changed_before_frame')
                blob, info = camera.take_frame(False)
                if camera.full_isp().digest(camera.configuration(camera.controls())) != active:
                    raise RuntimeError('isp_changed_during_frame')
            evidence = camera.frame_evidence(info)
            current = int(evidence['sdkTimestampNs'])
            if current <= cursor:
                raise RuntimeError('camera_frame_not_fresh')
            image = preview_bgr(camera, blob, info, cv2, np)
            detections, ms = infer(image)
            ok, jpg = cv2.imencode('.jpg',image)
            if not ok:
                raise RuntimeError('frame_encode_failed')
            number = len(report['frames'])
            filename = f'frame-{number:05d}.jpg'
            frame_bytes = jpg.tobytes()
            (args.output/filename).write_bytes(frame_bytes)
            return {'file':filename,'imageSha256':sha256(frame_bytes),'sdkTimestampNs':str(current),'phase':phase,
                    'modelSha256':model_sha,'tuningHash':active,'forwardMs':ms,
                    'frameWorkMs':(time.monotonic()-begin)*1000,'detections':detections}

        expected=original
        if candidate_builder:
            staged, metadata = candidate_builder(original['config'], args.gamma_strength, 160, 552)
            report['gamma']={'scope':'gamma.auto_attr.curve','strength':args.gamma_strength,'evidence':metadata,'images':{}}
            report['gamma']['images']['before']=archive_frame(camera,args.output,'A1-original',original['readbackHash'])
            collect('before',original['readbackHash'],args.seconds)
            wrote_configuration=True
            candidate=camera.execute('apply_tuning',{'tuning':staged,'tuningHash':native.digest(staged)})
            report['gamma']['curveReadback']=candidate['evidence']['streamVerification'].get('gammaCurrentCurve')
        elif effect is not None:
            if not original.get('contentBase64'):
                raise RuntimeError('original_effect_library_required')
            wrote_configuration=True
            candidate=camera.execute('tuning_load',{'contentBase64':base64.b64encode(effect).decode(),'sha256':args.effect_sha256})
        if wrote_configuration:
            expected=camera.execute('tuning_export',{})
            if expected['readbackHash']!=candidate['readbackHash']:
                raise RuntimeError('isp_candidate_readback_mismatch')
        report['tuningHash']=expected['readbackHash']
        write_json(args.output/'loaded-isp.json',expected)
        report['ispSnapshots']['loaded-isp.json']=sha256((args.output/'loaded-isp.json').read_bytes())
        if candidate_builder:
            report['gamma']['images']['after']=archive_frame(camera,args.output,'B-candidate',expected['readbackHash'])
        collect('after' if candidate_builder else 'live',expected['readbackHash'],args.seconds)
        report['status']='captured'
    except BaseException as error:
        report.update(status='failed', failure=str(error))
        raise
    finally:
        try:
            if wrote_configuration and original is not None and (camera.changed or camera.unconfirmed or camera.cleanup_required):
                if camera.cleanup_required:
                    camera.execute('preview_stop',{})
                restored = camera.execute('restore_tuning',{'tuning':original['config'],'tuningHash':original['readbackHash']})
                independent = camera.execute('tuning_export',{})
                if not camera.same_configuration(independent['config'], original['config']):
                    raise RuntimeError('original_isp_restore_unconfirmed')
                write_json(args.output/'restored-isp.json',{'readbackHash':independent['readbackHash'],
                                                            'streamVerification':restored['evidence'].get('streamVerification')})
                report['ispSnapshots']['restored-isp.json']=sha256((args.output/'restored-isp.json').read_bytes())
                report['restoration']='verified'
                if report.get('gamma') and independent['readbackHash']==original['readbackHash']:
                    report['gamma']['images']['restored']=archive_frame(camera,args.output,'A2-restored',independent['readbackHash'])
            elif original is not None:
                report['restoration']='no_write'
            camera.execute('preview_stop',{})
            report['previewStopped']=True
        except BaseException as error:
            report.update(restoration='unconfirmed', restorationFailure=str(error))
            raise
        finally:
            try:
                camera.close()
            finally:
                if report['status']=='captured' and report['restoration'] in ('verified','no_write') and report.get('previewStopped'):
                    report['status']='completed'
                    report['stage']='completed'
                write_json(report_file,report)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for flag in ('profile','model','static-image','model-zoo','camera-module','camera-config','output'):
        parser.add_argument('--'+flag,type=lambda path: Path(path).resolve(),required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--effect',type=lambda value:Path(value).resolve())
    mode.add_argument('--current-isp',action='store_true')
    mode.add_argument('--gamma-toolkit',type=lambda value:Path(value).resolve())
    parser.add_argument('--effect-sha256')
    parser.add_argument('--gamma-strength',type=float,default=.8)
    parser.add_argument('--seconds',type=int,choices=range(1,61),default=30,metavar='1..60')
    options=parser.parse_args()
    if bool(options.effect)!=bool(options.effect_sha256) or options.gamma_toolkit and not 0<options.gamma_strength<=.95:
        parser.error('Supply the ISP effect SHA-256 or select the bounded Gamma/default ISP mode.')
    def stop(_signal,_frame):
        raise KeyboardInterrupt('stopped_by_operator')
    signal.signal(signal.SIGTERM,stop)
    main(options)
