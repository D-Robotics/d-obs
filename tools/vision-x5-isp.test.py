#!/usr/bin/env python3
"""Stateful SDK protocol fixture: never a camera/ISP quality acceptance."""
import base64
import copy
import ctypes
import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
from unittest import mock
from pathlib import Path


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

camera=load('vision-x5-camera'); isp_module=load('vision-x5-isp')

class Function:
    def __init__(self,fn): self.fn=fn
    def __call__(self,*args): return self.fn(*args)

class Lib:
    names={0:'exposure',1:'awb',3:'cproc',4:'lsc',5:'ccm'}
    def __init__(self):
        self.fields={
          0:[('mode',0,0,1,0,1,1),('manual_attr.exp_time',4,2,1,float('nan'),float('nan'),0),('manual_attr.again',8,2,1,float('nan'),float('nan'),0)],
          1:[('mode',0,0,1,0,1,1)]+[(f'manual_attr.gain.{k}',4+i*4,2,1,float('nan'),float('nan'),0) for i,k in enumerate(('rgain','grgain','gbgain','bgain'))],
          3:[('mode',0,0,1,0,1,1)]+[(f'manual_attr.{k}',4+i*4,2,1,a,b,1) for i,(k,a,b) in enumerate((('bright',-127,127),('contrast',0,ctypes.c_float(1.999).value),('saturation',0,ctypes.c_float(1.999).value),('hue',-90,90)))],
          4:[('mode',0,0,1,0,1,1),('manual_attr.matrix',4,3,24,1024,16383,1)],
          5:[('configMode',0,1,1,float('nan'),float('nan'),0),('manual_attr.cc_matrix',4,2,9,float('nan'),float('nan'),0)],
        }
        self.state={0:struct.pack('=iffI',1,.01,1,99),1:struct.pack('=iffff',1,1,1,1,1),3:struct.pack('=iffff',1,0,1,1,0),4:struct.pack('=i24H',1,*([1024]*24)),5:struct.pack('=I9f',1,1,0,0,0,1,0,0,0,1)}
        self.ignore=False;self.fail_module=None;self.gets=0;self.writes=[];self.loads=[]
        for name,method in {
          'module_size':self.size,'module_name':lambda i:self.names.get(i,'readonly_'+str(i)).encode(),
          'module_writable':lambda i:int(i in self.state),'module_get':self.get,'module_set':self.set,
          'module_normalize':self.normalize,'module_field_count':lambda i:len(self.fields.get(i,[])),
          'module_field_info':self.field,'tuning_load':self.tuning_load}.items(): setattr(self,'x5w_'+name,Function(method))
    def size(self,i): return len(self.state[i]) if i in self.state else 4
    def get(self,_ctx,i,out,cap):
        self.gets+=1
        if i not in self.state:return -95
        ctypes.memmove(out,self.state[i],len(self.state[i]));return 0
    def set(self,_ctx,i,data,n):
        self.writes.append(i)
        if i==self.fail_module:return -5
        if not self.ignore:self.state[i]=ctypes.string_at(data,n)
        return 0
    def normalize(self,i,data,n):
        if i in (0,1,3,4) and struct.unpack_from('=i',ctypes.string_at(data,n))[0]==0:
            # getter-only/inactive union data is cleared in the real C bridge.
            size=n-8 if i==0 else n-4
            ctypes.memset(ctypes.addressof(data)+4,0,size)
        return 0
    def field(self,i,index,name,cap,offset,kind,count,low,high,editable):
        key,a,b,c,d,e,f=self.fields[i][index]; name.value=key.encode()
        for pointer,value in ((offset,a),(kind,b),(count,c),(low,d),(high,e),(editable,f)):pointer._obj.value=value
        return 0
    def tuning_load(self,_ctx,path):
        blob=Path(path.decode()).read_bytes();self.loads.append(blob)
        row=json.loads(blob)
        if 'bright' in row:
            raw=bytearray(self.state[3]);struct.pack_into('=f',raw,4,row['bright']);self.state[3]=bytes(raw)
        return 0

class Backend:
    source='sdk-state-fixture';abi=2
    def __init__(self,config):self.config=config;self.lib=Lib();self.ctx=1;self.isp=None;self.id=0;self.cleanup_fails=False;self.replay_fails=False
    check=staticmethod(camera.NativeBackend.check)
    def start(self):
        if not self.isp:self.isp=isp_module.Isp(self,self.config,camera.NativeError,camera.digest)
    def stop(self): pass
    def close(self): pass
    def controls(self):
        mode,bright,contrast,sat,hue=struct.unpack('=iffff',self.lib.state[3])
        return {key:{'value':v,'min':a,'max':b,'writable':bool(mode),'active':bool(mode),'nativeName':'hbn_isp_cproc_attr_t.manual_attr.'+native} for key,v,native,a,b in (('brightness',bright,'bright',-127,127),('contrast',contrast,'contrast',0,ctypes.c_float(1.999).value),('saturation',sat,'saturation',0,ctypes.c_float(1.999).value),('hue',hue,'hue',-90,90))}
    def set_control(self,key,value):
        raw=bytearray(self.lib.state[3]);struct.pack_into('=f',raw,4+('brightness','contrast','saturation','hue').index(key)*4,value);self.lib.state[3]=bytes(raw)
    def frame(self,raw=False):
        self.id+=1
        return b'\x40'*4+b'\x80\x80',dict(width=2,height=2,stride_y=2,stride_uv=2,size_y=4,size_uv=2,bit_depth=8,bayer=0,packing=3,alignment=0,timestamp_ns=1000+self.id,frame_id=self.id)
    def replay(self,data,metadata):
        self.replay_calls=getattr(self,'replay_calls',0)+1
        if self.replay_fails:raise camera.NativeError('raw_replay_failed',-5)
        value=min(235,max(16,struct.unpack_from('=H',data)[0]//4+16))
        _old,info=self.frame();info.update(timestamp_ns=9000,frame_id=123)
        return bytes([value]*4)+b'\x80\x80',info
    def replay_cleanup(self):
        if self.cleanup_fails:raise camera.NativeError('raw_replay_cleanup_failed',-5)

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=Path(self.temp.name)
        self.library=root/'base.json';self.library.write_text('{"bright":0,"blc":[0,0,0,0]}')
        self.config={'token':'t'*24,'board':'RDK X5','sensorModel':'IMX415','sensorVendor':'Sony','sdkVersion':'fixture-sdk','cameraInterface':'MIPI CSI-2','cameraMode':'fixture','nativeLibrary':'/fixture.so','sensorConfig':'imx415-30fps-2lane','csiPort':0,'port':3217,'stateDir':str(root/'private'),'colorMatrix':'bt709','colorRange':'limited','blackLevel':0,'whiteLevel':1023,'discardFrames':1,'effectLibrary':str(self.library),
          'modeReadbackEvidence':{'awb':'fixture/mode-roundtrip-qualified'},'awbGainLimits':{'min':.5,'max':4,'evidenceRef':'fixture/operator-bounds'},'ispFieldPolicies':{'ccm.manual_attr.cc_matrix':{'min':-4,'max':4,'evidenceRef':'fixture/sdk-validation'},'ccm.configMode':{'min':1,'max':1,'evidenceRef':'fixture/manual-mode'}},
          'calibrationBindings':{'ccm':{'module':'ccm','field':'manual_attr.cc_matrix','matrixOrder':'row-major','modeField':'configMode','modeValue':1,'evidenceRef':'fixture/sdk-schema'},'lsc':{'module':'lsc','field':'manual_attr.matrix','xPositionsNormalized':[0,.5,1],'yPositionsNormalized':[0,1],'channelOrder':['R','Gr','Gb','B'],'unityCode':1024,'modeField':'mode','modeValue':1,'evidenceRef':'fixture/mesh-schema'},'awb':{'module':'awb','gainFields':{'manual_attr.gain.rgain':'redGain','manual_attr.gain.grgain':'greenGain','manual_attr.gain.gbgain':'greenGain','manual_attr.gain.bgain':'blueGain'},'modeField':'mode','modeValue':1,'evidenceRef':'fixture/wb-schema'},'blc':{'target':'effect-library','evidenceRef':'fixture/json-schema','mappings':[{'resultPath':[k],'jsonPointer':'/blc/'+str(i),'encoding':'integer','min':0,'max':1023} for i,k in enumerate(('R','Gr','Gb','B'))]}}}
        self.backend=Backend(self.config);self.camera=camera.Camera(self.config,backend=self.backend,preflight=lambda:{'source':'fixture'});self.camera.execute('bringup',{})
    def config_now(self):return copy.deepcopy(self.backend.isp.read())
    def result(self,op,values,**extra):return {'schema':'rdk.x5-calibration-result.v1','status':'computed','operation':op,'parameters':{'values':values,**extra},'outputSha256':'a'*64}
    def vendor_binding(self, mappings=None, template=None):
        isp=self.backend.isp
        if template is not None:
            self.library.write_text(json.dumps(template));isp.snapshot(self.library.read_bytes())
        current=isp.read();saved=isp.load_snapshot(current['snapshotId'])
        baseline={name:isp.values(isp.modules[name],isp.normalized(isp.modules[name],base64.b64decode(raw))) for name,raw in saved['modules'].items()}
        binding={'schema':isp_module.EXPORT_BINDING,**{key:self.config[key] for key in isp_module.EXPORT_PROFILE},'layoutHash':isp.layout,
            'templateSha256':saved['librarySha256'],'baselineModulesSha256':camera.digest(baseline),'evidenceRef':'software-fixture/explicit-template-schema-not-a-vendor-binding',
            'mappings':mappings or [{'module':'cproc','field':'manual_attr.bright','jsonPointer':'/bright','encoding':'float32','min':-127,'max':127}]}
        self.config['effectLibraryExportBinding']=binding;self.camera.config['effectLibraryExportBinding']=binding
        return binding
    def vendor_export(self):return self.camera.execute('tuning_export',{})['vendorCandidate']
    def vendor_inputs(self,candidate):return {'artifactRole':'vendor_effect_library_candidate','contentBase64':candidate['contentBase64'],'sha256':candidate['sha256']}

    def test_vendor_export_without_binding_is_blocked_and_legacy_library_is_explicit_archive(self):
        self.camera.execute('controls_set',{'values':{'brightness':17}})
        result=self.camera.execute('tuning_export',{})
        self.assertEqual(result['vendorCandidate']['status'],'blocked');self.assertEqual(result['vendorCandidate']['reason'],'vendor_export_binding_required')
        self.assertNotIn('contentBase64',result['vendorCandidate']);self.assertFalse(result['independentlyDeployable'])
        self.assertEqual(result['archivedLibraryRole'],'previously_declared_input_not_current_module_export')
        self.assertEqual(json.loads(base64.b64decode(result['contentBase64']))['bright'],0)
        self.assertEqual(result['config']['modules']['cproc']['manual_attr.bright'],17)
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_export_encodes_actual_module_change_and_keeps_template_unmapped_values(self):
        binding=self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}})
        before=self.backend.lib.gets;result=self.camera.execute('tuning_export',{});candidate=result['vendorCandidate'];blob=base64.b64decode(candidate['contentBase64'])
        self.assertEqual(candidate['status'],'generated_requires_target_validation');self.assertGreater(self.backend.lib.gets,before)
        self.assertEqual(json.loads(blob),{'bright':17,'blc':[0,0,0,0]});self.assertEqual(candidate['sha256'],hashlib.sha256(blob).hexdigest());self.assertEqual(candidate['bytes'],len(blob))
        self.assertEqual(candidate['modifiedFields'],['cproc.manual_attr.bright']);self.assertEqual(candidate['bindingHash'],camera.digest(binding));self.assertEqual(candidate['sourceReadbackHash'],result['readbackHash'])
        self.assertEqual(candidate['hardwareVerification'],'unverified');self.assertEqual(candidate['qualityVerification'],'unverified')
        self.assertNotIn('snapshotId',candidate);self.assertNotIn('nativeBase64',json.dumps(candidate));self.assertNotIn(str(self.temp.name),json.dumps(candidate))
        self.assertEqual(base64.b64decode(result['contentBase64']),self.library.read_bytes());self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_export_rejects_every_unmapped_modified_field_and_profile_binding_mismatch(self):
        binding=self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17,'contrast':1.5}})
        blocked=self.vendor_export();self.assertEqual(blocked['reason'],'vendor_export_unmapped_modified_field');self.assertNotIn('contentBase64',blocked)
        for key,value in (('sdkVersion','wrong-sdk'),('sensorConfig','imx415-30fps-4lane'),('cameraMode','wrong-mode'),('csiPort',2),('layoutHash','f'*64),('templateSha256','e'*64),('baselineModulesSha256','d'*64)):
            old=binding[key];binding[key]=value
            self.assertEqual(self.vendor_export()['status'],'blocked');binding[key]=old
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_export_requires_explicit_array_shape_order_and_existing_numeric_targets(self):
        row={'module':'ccm','field':'manual_attr.cc_matrix','jsonPointer':'/matrix','encoding':'float32','min':-4,'max':4,'shape':[3,3],'order':[0,3,6,1,4,7,2,5,8]}
        self.vendor_binding([row],{'bright':0,'matrix':[[1,0,0],[0,1,0],[0,0,1]]})
        candidate=self.config_now();values=[1.25,.25,0,0,1,0,0,0,.75];candidate['modules']['ccm']['manual_attr.cc_matrix']=values
        self.camera.apply_full(candidate)
        artifact=self.vendor_export();self.assertEqual(json.loads(base64.b64decode(artifact['contentBase64']))['matrix'],[[1.25,0,0],[.25,1,0],[0,0,.75]])
        del row['shape'];del row['order'];self.assertEqual(self.vendor_export()['reason'],'vendor_export_array_layout_required')
        row.update(shape=[9],order=list(range(9)));self.assertEqual(self.vendor_export()['reason'],'vendor_export_target_shape_mismatch')
        row['jsonPointer']='/does-not-exist';self.assertEqual(self.vendor_export()['reason'],'vendor_export_existing_numeric_target_required')
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_export_rejects_range_nonfinite_duplicate_and_overlapping_mapping(self):
        binding=self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}})
        row=binding['mappings'][0];row['max']=10;self.assertEqual(self.vendor_export()['reason'],'vendor_export_out_of_range');row['max']=127
        row['scale']=1e308;self.assertEqual(self.vendor_export()['reason'],'vendor_export_nonfinite');row['scale']=1
        binding['mappings'].append(dict(row));self.assertEqual(self.vendor_export()['reason'],'vendor_export_mapping_overlap');binding['mappings'].pop()
        for value in (float('inf'),float('nan'),True,10**400):
            row['min']=value
            with self.assertRaises(ValueError):camera.validate_config(self.config)
        row['min']=-127;binding['evidenceRef']=''
        with self.assertRaises(ValueError):camera.validate_config(self.config)
        for blob in (b'{"bright":0,"bright":1}',b'{"bright":1e400}',b'{"bright":NaN}'):
            with self.assertRaises(ValueError):isp_module.Isp.vendor_document(blob)
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_candidate_explicit_load_requires_owned_receipt_and_revalidates_binding_before_sdk(self):
        binding=self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}});candidate=self.vendor_export();inputs=self.vendor_inputs(candidate)
        altered=json.loads(base64.b64decode(candidate['contentBase64']));altered['bright']=18;blob=json.dumps(altered).encode()
        tampered={**inputs,'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()}
        with self.assertRaisesRegex(ValueError,'receipt_required'):self.camera.execute('tuning_load',tampered)
        old=binding['evidenceRef'];binding['evidenceRef']='software-fixture/other-evidence'
        with self.assertRaisesRegex(ValueError,'binding_mismatch'):self.camera.execute('tuning_load',inputs)
        binding['evidenceRef']=old
        receipt=self.backend.isp.vendor_directory()/(candidate['sha256']+'.json');receipt.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'private_snapshot_required'):self.camera.execute('tuning_load',inputs)
        self.assertEqual(self.backend.lib.loads,[]);self.assertFalse(self.camera.unconfirmed)

    def test_legacy_load_of_generated_bytes_does_not_gain_candidate_proof_without_role(self):
        self.vendor_binding();candidate=self.vendor_export()
        result=self.camera.execute('tuning_load',{'contentBase64':candidate['contentBase64'],'sha256':candidate['sha256']})
        self.assertNotIn('vendorCandidateValidation',result['evidence']);self.assertIsNone(self.backend.isp.vendor_last_load)
        self.assertFalse((self.backend.isp.vendor_directory()/(candidate['sha256']+'.reload.json')).exists())

    def test_vendor_candidate_reload_after_restore_compares_independent_getters_and_new_frame(self):
        original=self.config_now();self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}});candidate=self.vendor_export()
        self.camera.apply_full(original,True);self.assertEqual(self.config_now()['modules']['cproc']['manual_attr.bright'],0)
        before=self.backend.lib.gets;result=self.camera.execute('tuning_load',self.vendor_inputs(candidate));receipt=result['evidence']['vendorCandidateValidation']
        self.assertEqual(json.loads(self.backend.lib.loads[-1])['bright'],17);self.assertGreater(self.backend.lib.gets,before)
        self.assertEqual(receipt['status'],'target_reload_recorded');self.assertEqual(receipt['candidateSha256'],candidate['sha256']);self.assertEqual(receipt['bindingHash'],candidate['bindingHash'])
        self.assertEqual(receipt['sourceReadbackHash'],candidate['sourceReadbackHash']);self.assertEqual(receipt['actualReloadReadbackHash'],result['readbackHash'])
        self.assertEqual(receipt['streamVerification']['status'],'verified');self.assertEqual(receipt['source'],'sdk-state-fixture');self.assertFalse(receipt['freshSessionObserved'])
        self.assertEqual(receipt['qualityVerification'],'unverified');self.assertFalse(receipt['unexposedLibraryFieldsReadback'])
        self.assertEqual(self.vendor_export()['targetValidation'],'target_reload_recorded')
        self.camera.apply_full(original,True);self.assertFalse(self.camera.unconfirmed);self.assertEqual(self.config_now()['modules']['cproc']['manual_attr.bright'],0)

    def test_vendor_candidate_ignored_load_or_bad_stream_never_records_validation(self):
        original=self.config_now();self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}});candidate=self.vendor_export();self.camera.apply_full(original,True)
        self.backend.lib.x5w_tuning_load=Function(lambda *_args:0)
        with self.assertRaisesRegex(camera.NativeError,'readback_mismatch'):self.camera.execute('tuning_load',self.vendor_inputs(candidate))
        self.assertTrue(self.camera.unconfirmed);self.assertTrue(self.camera.cleanup_required)
        self.assertFalse((self.backend.isp.vendor_directory()/(candidate['sha256']+'.reload.json')).exists())

    def test_vendor_candidate_matching_sdk_readback_without_fresh_frame_is_not_recorded(self):
        original=self.config_now();self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}});candidate=self.vendor_export();self.camera.apply_full(original,True)
        self.backend.frame=lambda *_args:(_ for _ in ()).throw(camera.NativeError('fixture_stream_broken_after_scene',-36))
        with self.assertRaisesRegex(camera.NativeError,'fixture_stream_broken'):self.camera.execute('tuning_load',self.vendor_inputs(candidate))
        self.assertEqual(struct.unpack_from('=f',self.backend.lib.state[3],4)[0],17)
        self.assertTrue(self.camera.unconfirmed);self.assertTrue(self.camera.cleanup_required)
        self.assertFalse((self.backend.isp.vendor_directory()/(candidate['sha256']+'.reload.json')).exists())

    def test_vendor_candidate_receipt_corruption_is_rejected_before_sdk(self):
        self.vendor_binding();candidate=self.vendor_export();receipt=self.backend.isp.vendor_directory()/(candidate['sha256']+'.json')
        record=json.loads(receipt.read_text());record.pop('exportSessionId');isp_module.atomic_json(receipt,record)
        with self.assertRaisesRegex(ValueError,'receipt_invalid'):self.camera.execute('tuning_load',self.vendor_inputs(candidate))
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_export_covers_real_external_getter_changes_and_native_bounds(self):
        self.vendor_binding();raw=bytearray(self.backend.lib.state[3]);struct.pack_into('=f',raw,8,1.5);self.backend.lib.state[3]=bytes(raw)
        self.assertEqual(self.vendor_export()['reason'],'vendor_export_unmapped_modified_field')
        struct.pack_into('=f',raw,8,1);struct.pack_into('=f',raw,4,128);self.backend.lib.state[3]=bytes(raw)
        self.assertEqual(self.vendor_export()['reason'],'vendor_export_source_out_of_range')
        self.assertEqual(self.backend.lib.loads,[])

    def test_vendor_candidate_new_fixture_instance_does_not_fabricate_fresh_native_session(self):
        original=self.config_now();self.vendor_binding();self.camera.execute('controls_set',{'values':{'brightness':17}});candidate=self.vendor_export();old_session=self.backend.isp.session_id
        self.camera.apply_full(original,True);restarted=self.restart_camera()
        result=restarted.execute('tuning_load',self.vendor_inputs(candidate));receipt=result['evidence']['vendorCandidateValidation']
        self.assertNotEqual(receipt['reloadSessionId'],old_session);self.assertEqual(receipt['exportSessionId'],old_session)
        self.assertEqual(receipt['sessionBoundary'],'unqualified_backend_instance');self.assertFalse(receipt['freshSessionObserved'])
        self.assertEqual(receipt['hardwareVerification'],'unverified')

    def test_vendor_reload_receipt_cannot_be_fabricated_without_real_sdk_call(self):
        self.vendor_binding();candidate=self.vendor_export();blob=base64.b64decode(candidate['contentBase64'])
        with self.assertRaisesRegex(ValueError,'fresh_frame_required'):self.backend.isp.record_vendor_reload(blob,{'candidateSha256':candidate['sha256']},{'status':'verified'})
        self.assertEqual(self.backend.lib.loads,[])
    def test_capability_admission_does_not_advertise_unqualified_replay_or_unbound_calibration(self):
        self.assertNotIn('process_raw',self.camera.capabilities()['operations'])
        self.assertFalse(self.camera.capabilities()['rawReplay'])
        self.config['modeReadbackEvidence']['exposure']='fixture/qualified-exposure-readback'
        self.assertIn('process_raw',self.camera.capabilities()['operations'])
        self.assertTrue(self.camera.capabilities()['rawReplay'])
        self.camera.config['calibrationBindings']={}
        self.assertNotIn('calibration_apply',self.camera.capabilities()['operations'])
        self.assertFalse(self.camera.capabilities()['hardwareVerified'])

    def test_actual_ae_ranges_intersect_private_policy_and_disjoint_bounds_never_write(self):
        isp=self.backend.isp
        self.config['modeReadbackEvidence']['exposure']='fixture/qualified-mode'
        isp.policies['exposure.manual_attr.exp_time']={'min':.005,'max':.02,'evidenceRef':'fixture/narrow-operator-policy'}
        original_controls=self.backend.controls
        self.backend.controls=lambda:{**original_controls(),'exposureUs':{'min':100,'max':100_000,'value':10_000,'writable':True,'active':True},'gain':{'min':1,'max':16,'value':1,'writable':True,'active':True}}
        baseline=isp.baseline()
        rule=next(row for row in baseline['rules'] if row['path']=='/modules/exposure/manual_attr.exp_time')
        self.assertEqual((rule['min'],rule['max']),(.005,.02))
        candidate=self.config_now();candidate['modules']['exposure']['manual_attr.exp_time']=ctypes.c_float(.001).value
        with self.assertRaisesRegex(ValueError,'out_of_range'):self.camera.apply_full(candidate)
        isp.policies['exposure.manual_attr.exp_time']['min']=1
        with self.assertRaisesRegex(ValueError,'range_disjoint'):isp.baseline()
        self.assertEqual(self.backend.lib.writes,[])

    def test_full_snapshot_get_is_independent_and_raw_structs_are_private(self):
        result=self.camera.execute('tuning_get',{});self.assertEqual(result['readbackHash'],camera.digest(result['config']));self.assertEqual(set(result['config']['modules']),{'exposure','awb','cproc','lsc','ccm'});self.assertNotIn('library',result['config']);self.assertGreater(self.backend.lib.gets,10)
    def test_readonly_sdk_observations_get_actual_bytes_outside_configuration_hash(self):
        before=camera.digest(self.config_now());self.backend.lib.state[2]=struct.pack('=I',42)
        result=self.camera.execute('tuning_get',{});row=result['observations']['readonly_2']
        self.assertEqual(row['status'],'observed');self.assertEqual(row['normalizedSha256'],hashlib.sha256(struct.pack('=I',42)).hexdigest());self.assertEqual(row['knownValues'],{})
        self.assertEqual(row['interpretation'],'sdk_diagnostic_bytes_not_image_quality_validation');self.assertNotIn('contentBase64',row)
        self.assertEqual(result['observations']['readonly_6']['status'],'unavailable');self.assertEqual(result['observations']['readonly_6']['sdkCode'],-95);self.assertEqual(result['readbackHash'],before)
        self.backend.lib.state[2]=struct.pack('=I',99)
        second=self.camera.execute('tuning_get',{});self.assertNotEqual(second['observations']['readonly_2']['normalizedSha256'],row['normalizedSha256']);self.assertEqual(second['readbackHash'],before)
    def test_full_apply_and_restore_compare_sdk_bytes_not_request_echo(self):
        original=self.config_now();candidate=copy.deepcopy(original);candidate['modules']['cproc']['manual_attr.contrast']=ctypes.c_float(1.3).value
        result=self.camera.execute('apply_tuning',{'tuning':candidate,'tuningHash':camera.digest(candidate)});self.assertEqual(result['readbackHash'],camera.digest(candidate));self.assertTrue(self.camera.changed)
        self.camera.execute('restore_tuning',{'tuning':original,'tuningHash':camera.digest(original)});self.assertFalse(self.camera.changed);self.assertEqual(self.backend.lib.loads,[])
    def test_ignored_sdk_write_is_unconfirmed_and_fences_new_writes(self):
        candidate=self.config_now();candidate['modules']['cproc']['manual_attr.bright']=20;self.backend.lib.ignore=True
        with self.assertRaisesRegex(camera.NativeError,'isp_module_readback_mismatch'):self.camera.execute('apply_tuning',{'tuning':candidate,'tuningHash':camera.digest(candidate)})
        self.assertTrue(self.camera.unconfirmed)
        with self.assertRaisesRegex(ValueError,'restore_required'):self.camera.execute('controls_set',{'values':{'brightness':2}})
    def test_partial_module_write_is_recoverable_after_restart(self):
        original=self.config_now();candidate=copy.deepcopy(original);candidate['modules']['awb']['manual_attr.gain.rgain']=2;candidate['modules']['cproc']['manual_attr.bright']=30;self.backend.lib.fail_module=3
        with self.assertRaises(camera.NativeError):self.camera.apply_full(candidate)
        self.assertEqual(struct.unpack_from('=f',self.backend.lib.state[1],4)[0],2)
        self.backend.lib.fail_module=None;restarted=camera.Camera(self.config,backend=self.backend,preflight=lambda:{})
        self.assertTrue(restarted.unconfirmed);restarted.apply_full(original,True);self.assertFalse(restarted.unconfirmed)
        self.assertEqual(self.backend.lib.loads,[])
        self.assertIsNone(restarted.recovery_scope)

    def restart_camera(self):
        # Reconstruct both objects from private files, rather than inheriting
        # the first daemon's in-memory snapshot pointer or recovery intent.
        self.backend.isp = isp_module.Isp(self.backend,self.config,camera.NativeError,camera.digest)
        return camera.Camera(self.config,backend=self.backend,preflight=lambda:{})

    def optional_module_fixture(self, disabled=True):
        config={**self.config,'stateDir':str(Path(self.temp.name)/('partial' if disabled else 'strict'))}
        names={13:'hdr_exposure',24:'autofocus',25:'rgbir'}
        if disabled:
            config['disabledIspModules']={name:{**{key:config[key] for key in ('sdkVersion','cameraMode','sensorConfig')},
                'observedSdkCode':-35,'evidenceRef':'fixture/linear-module-getter-failure'} for name in names.values()}
        backend=Backend(config)
        backend.lib.names={**backend.lib.names,**names}
        for module_id in names:
            backend.lib.state[module_id]=struct.pack('=i',1)
            backend.lib.fields[module_id]=[('mode',0,0,1,0,1,1)]
        getter=backend.lib.get
        def optional_get(ctx,module_id,out,size):
            return -35 if module_id in names else getter(ctx,module_id,out,size)
        backend.lib.x5w_module_get=Function(optional_get)
        instance=camera.Camera(config,backend=backend,preflight=lambda:{})
        return config,backend,instance

    def test_explicit_disabled_modules_keep_actual_error_and_partial_scope_without_writes(self):
        config,backend,instance=self.optional_module_fixture()
        instance.execute('bringup',{})
        exported=instance.execute('tuning_export',{})
        self.assertEqual(exported['excludedModules'],config['disabledIspModules'])
        self.assertEqual(exported['evidence']['moduleReadbackScope'],'configured_public_modules_partial')
        self.assertEqual(base64.b64decode(exported['contentBase64']),self.library.read_bytes())
        for name in config['disabledIspModules']:
            self.assertNotIn(name,exported['config']['modules'])
            row=exported['observations'][name]
            self.assertEqual((row['status'],row['sdkCode']),('unavailable',-35))
            self.assertTrue(row['excludedFromSnapshot'])
            self.assertEqual(row['exclusionEvidence']['observedSdkCode'],-35)
        candidate=copy.deepcopy(exported['config']);candidate['modules']['hdr_exposure']={'mode':1}
        with self.assertRaisesRegex(ValueError,'complete_isp_snapshot_required'):
            instance.apply_full(candidate)
        self.assertEqual(backend.lib.writes,[])
        self.assertEqual(backend.lib.loads,[])

    def test_get_control_fail_without_explicit_exclusion_still_fails_closed(self):
        _config,backend,instance=self.optional_module_fixture(False)
        with self.assertRaises(camera.NativeError) as failed: instance.execute('bringup',{})
        self.assertEqual(failed.exception.sdk_code,-35)
        self.assertEqual(str(failed.exception),'isp_module_readback_failed')
        self.assertEqual(backend.lib.writes,[])

    def test_disabled_configuration_cannot_restore_a_broader_old_snapshot(self):
        _config,backend,instance=self.optional_module_fixture()
        # An otherwise equal pipeline without exclusions has another layout.
        broad_config={**instance.config};broad_config.pop('disabledIspModules')
        broad=isp_module.Isp(backend,broad_config,camera.NativeError,camera.digest)
        instance.execute('bringup',{})
        candidate=copy.deepcopy(backend.isp.read());candidate['layoutHash']=broad.layout
        with self.assertRaisesRegex(ValueError,'unsupported_isp_tuning_format'):
            instance.apply_full(candidate,True)
        self.assertEqual(backend.lib.writes,[])

    def test_disabled_configuration_rejects_core_unknown_names_and_wrong_identity(self):
        config,backend,_instance=self.optional_module_fixture()
        row=next(iter(config['disabledIspModules'].values()))
        for disabled in ({'exposure':row},{'awb':row},{'cproc':row},
                         {'hdr_exposure':{**row,'sdkVersion':'another-sdk'}},
                         {'hdr_exposure':{**row,'sensorConfig':'imx415-30fps-4lane'}},
                         {'hdr_exposure':{**row,'cameraMode':'another-mode'}},
                         {'hdr_exposure':{**row,'observedSdkCode':False}},
                         {'hdr_exposure':{**row,'evidenceRef':''}},
                         {'hdr_exposure':{**row,'path':'/tmp/anything'}}):
            with self.assertRaisesRegex(ValueError,'invalid_disabled_isp_modules'):
                camera.validate_config({**config,'disabledIspModules':disabled})
        with self.assertRaisesRegex(ValueError,'invalid_disabled_isp_modules'):
            isp_module.Isp(backend,{**config,'disabledIspModules':{'not_a_real_module':row}},camera.NativeError,camera.digest)
        with self.assertRaisesRegex(ValueError,'invalid_inputs'):
            self.camera.execute('tuning_get',{'disabledIspModules':config['disabledIspModules']})

    def test_module_intent_is_durable_before_sdk_write_and_recovery_never_loads_scene(self):
        original=self.config_now();candidate=copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.contrast']=ctypes.c_float(1.05).value
        setter=self.backend.lib.set
        def checked_write(*args):
            row=json.loads(self.camera.journal_file.read_text())
            self.assertEqual((row['outcome'],row['recoveryScope']),('pending','modules'))
            self.assertEqual(row['original'],original)
            return setter(*args)
        self.backend.lib.x5w_module_set=Function(checked_write)
        self.camera.apply_full(candidate)
        restored=self.camera.apply_full(original,True)
        self.assertEqual(restored['evidence']['writeIntent'],'modules')
        self.assertEqual(restored['evidence']['streamVerification']['status'],'verified')
        self.assertEqual(self.backend.lib.loads,[])
        self.assertIsNone(json.loads(self.camera.journal_file.read_text())['recoveryScope'])

    def test_failed_controls_write_recovers_complete_original_without_scene_after_restart(self):
        original=self.config_now();setter=self.backend.set_control
        def failed_write(*args):
            row=json.loads(self.camera.journal_file.read_text())
            self.assertEqual((row['outcome'],row['recoveryScope']),('pending','modules'))
            setter(*args)
            raise camera.NativeError('isp_write_failed',-5)
        self.backend.set_control=failed_write
        with self.assertRaisesRegex(camera.NativeError,'isp_write_failed'):
            self.camera.execute('controls_set',{'values':{'brightness':10}})
        self.backend.set_control=setter
        restarted=self.restart_camera()
        self.assertTrue(restarted.unconfirmed)
        self.assertEqual(restarted.recovery_scope,'modules')
        restarted.apply_full(original,True)
        self.assertEqual(self.backend.lib.loads,[])
        self.assertFalse(restarted.changed)

    def test_legacy_or_invalid_scope_recovery_loads_library_conservatively(self):
        original=self.config_now();candidate=copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.bright']=20
        for scope in (None,'unrecognized'):
            self.camera.apply_full(candidate)
            row=json.loads(self.camera.journal_file.read_text())
            if scope is None: row.pop('recoveryScope')
            else: row['recoveryScope']=scope
            self.camera.journal_file.write_text(json.dumps(row))
            restarted=self.restart_camera()
            self.assertEqual(restarted.recovery_scope,'library')
            before=len(self.backend.lib.loads)
            restarted.apply_full(original,True)
            self.assertEqual(len(self.backend.lib.loads),before+1)
            self.assertEqual(self.backend.lib.loads[-1],self.library.read_bytes())
            self.camera=restarted

    def test_restarted_module_recovery_escalates_if_declared_library_changed(self):
        original=self.config_now();candidate=copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.bright']=20
        self.camera.apply_full(candidate)
        original_library=self.library.read_bytes()
        self.library.write_bytes(b'{"bright":91}')
        restarted=self.restart_camera()
        restored=restarted.apply_full(original,True)
        self.assertEqual(restored['evidence']['writeIntent'],'library')
        self.assertEqual(self.backend.lib.loads,[original_library])

    def test_same_sha_library_load_and_mixed_module_writes_keep_library_scope_until_original(self):
        original=self.config_now();candidate=copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.bright']=10
        self.camera.apply_full(candidate)
        blob=self.library.read_bytes();load=self.backend.lib.tuning_load
        def checked_load(*args):
            row=json.loads(self.camera.journal_file.read_text())
            self.assertEqual((row['outcome'],row['recoveryScope']),('pending','library'))
            return load(*args)
        self.backend.lib.x5w_tuning_load=Function(checked_load)
        self.camera.execute('tuning_load',{'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
        candidate=self.config_now();candidate['modules']['cproc']['manual_attr.bright']=30
        self.camera.apply_full(candidate)
        self.camera.execute('controls_set',{'values':{'brightness':31}})
        self.assertEqual(json.loads(self.camera.journal_file.read_text())['recoveryScope'],'library')
        restarted=self.restart_camera()
        self.assertEqual(restarted.recovery_scope,'library')
        restored=restarted.apply_full(original,True)
        self.assertEqual(restored['evidence']['writeIntent'],'library')
        self.assertEqual(self.backend.lib.loads,[blob,blob])
        self.assertIsNone(restarted.recovery_scope)

    def test_other_snapshot_recovery_does_not_clear_original_scope(self):
        original=self.config_now();candidate=copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.bright']=20
        self.camera.apply_full(candidate)
        another,_missing=self.backend.isp.snapshot()
        self.camera.apply_full(another,True)
        row=json.loads(self.camera.journal_file.read_text())
        self.assertEqual((row['outcome'],row['recoveryScope']),('confirmed','modules'))
        self.assertEqual(row['original'],original)
        self.camera.apply_full(original,True)
        self.assertEqual(self.backend.lib.loads,[])
        self.assertFalse(self.camera.changed)

    def test_different_library_snapshot_apply_journals_library_before_scene(self):
        original=self.config_now();blob=b'{"bright":24}'
        self.camera.execute('tuning_load',{'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
        new_library=self.config_now()
        self.camera.apply_full(original,True)
        load=self.backend.lib.tuning_load
        def checked_load(*args):
            self.assertEqual(json.loads(self.camera.journal_file.read_text())['recoveryScope'],'library')
            return load(*args)
        self.backend.lib.x5w_tuning_load=Function(checked_load)
        result=self.camera.apply_full(new_library)
        self.assertEqual(result['evidence']['writeIntent'],'library')
        self.assertEqual(self.backend.lib.loads[-1],blob)

    def test_legacy_controls_restore_cannot_clear_library_recovery_scope(self):
        blob=b'{"bright":24}'
        self.camera.execute('tuning_load',{'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
        before=len(self.backend.lib.writes)
        with self.assertRaisesRegex(camera.NativeError,'isp_full_library_restore_required'):
            self.camera.set_values({'brightness':0,'contrast':1,'saturation':1,'hue':0},complete=True,recovering=True)
        self.assertEqual(len(self.backend.lib.writes),before)
        self.assertEqual(self.camera.recovery_scope,'library')
    def test_unknown_snapshot_wrong_layout_and_nonrepresentable_float_reject_before_write(self):
        for edit,code in ((lambda t:t.update(snapshotId='0'*32),'FileNotFound'),(lambda t:t.update(layoutHash='f'*64),'unsupported_isp_tuning_format'),(lambda t:t['modules']['cproc'].update({'manual_attr.contrast':1.3}),'quantization')):
            candidate=self.config_now();edit(candidate);before=len(self.backend.lib.writes)
            with self.assertRaises(Exception):self.camera.apply_full(candidate)
            self.assertEqual(len(self.backend.lib.writes),before)
    def test_readonly_fields_and_unqualified_ae_mode_never_write(self):
        candidate=self.config_now();candidate['modules']['exposure']['mode']=0
        with self.assertRaisesRegex(ValueError,'readonly'):self.camera.apply_full(candidate)
        candidate=self.config_now();candidate['modules']['exposure']['manual_attr.again']=2
        with self.assertRaisesRegex(ValueError,'readonly'):self.camera.apply_full(candidate,True)
        self.assertEqual(self.backend.lib.writes,[])
    def test_unexposed_native_configuration_change_cannot_keep_same_hash(self):
        raw=bytearray(self.backend.lib.state[0]);struct.pack_into('=I',raw,12,77);self.backend.lib.state[0]=bytes(raw)
        with self.assertRaisesRegex(camera.NativeError,'unexposed_configuration_changed'):self.camera.execute('tuning_get',{})
    def test_effect_library_load_getter_export_and_complete_original_restore(self):
        original=self.config_now();blob=b'{"bright":24,"blc":[5,6,7,8]}'
        result=self.camera.execute('tuning_load',{'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
        self.assertEqual(result['config']['modules']['cproc']['manual_attr.bright'],24);self.assertEqual(base64.b64decode(result['contentBase64']),blob);self.assertFalse(result['evidence']['unexposedLibraryFieldsReadback'])
        self.camera.apply_full(original,True);self.assertEqual(self.backend.lib.loads[-1],self.library.read_bytes())

    def test_scene_sdk_success_and_matching_getters_do_not_confirm_a_broken_stream(self):
        original = self.config_now()
        blob = b'{"bright":24,"blc":[5,6,7,8]}'
        self.backend.frame = mock.Mock(side_effect=camera.NativeError('camera_stream_start_failed', -36))
        with self.assertRaisesRegex(camera.NativeError, 'camera_stream_start_failed'):
            self.camera.execute('tuning_load', {'contentBase64':base64.b64encode(blob).decode(), 'sha256':hashlib.sha256(blob).hexdigest()})
        # Scene SDK returned zero and its public getter changed, yet no new
        # frame exists. Preserve the baseline and fence every subsequent write.
        self.assertEqual(struct.unpack_from('=f', self.backend.lib.state[3], 4)[0], 24)
        journal = json.loads(self.camera.journal_file.read_text())
        self.assertEqual(journal['outcome'], 'unconfirmed')
        self.assertTrue(journal['cleanupRequired'])
        count = len(self.backend.lib.loads)
        with self.assertRaisesRegex(camera.NativeError, 'camera_stream_cleanup_required'):
            self.camera.apply_full(original, True)
        self.camera.close()
        self.assertEqual(len(self.backend.lib.loads), count)
        self.assertEqual(json.loads(self.camera.journal_file.read_text())['outcome'], 'unconfirmed')

    def test_full_recovery_checks_frame_before_persisting_restored(self):
        original = self.config_now()
        candidate = copy.deepcopy(original)
        candidate['modules']['cproc']['manual_attr.bright'] = 20
        self.camera.apply_full(candidate)
        self.backend.frame = mock.Mock(side_effect=camera.NativeError('camera_frame_stale'))
        with self.assertRaisesRegex(camera.NativeError, 'camera_frame_stale'):
            self.camera.apply_full(original, True)
        self.assertEqual(self.config_now(), original)
        self.assertTrue(self.camera.unconfirmed)
        self.assertTrue(self.camera.cleanup_required)
        self.assertEqual(json.loads(self.camera.journal_file.read_text())['outcome'], 'unconfirmed')

    def test_scene_sdk_start_error_is_fenced_before_shutdown_can_retry(self):
        original = self.config_now()
        switch = mock.Mock(return_value=-36)
        self.backend.lib.x5w_tuning_load = Function(switch)
        blob = b'{"bright":24}'
        with self.assertRaisesRegex(camera.NativeError, 'isp_effect_library_load_failed'):
            self.camera.execute('tuning_load', {'contentBase64':base64.b64encode(blob).decode(), 'sha256':hashlib.sha256(blob).hexdigest()})
        self.assertTrue(self.camera.cleanup_required)
        self.assertTrue(json.loads(self.camera.journal_file.read_text())['cleanupRequired'])
        self.camera.close()
        self.assertEqual(switch.call_count, 1)
        restarted = camera.Camera(self.config, backend=self.backend, preflight=lambda:{})
        restarted.execute('preview_stop', {})
        with self.assertRaisesRegex(camera.NativeError, 'isp_effect_library_load_failed'):
            restarted.apply_full(original, True)
        self.assertTrue(restarted.cleanup_required)
        restarted.close()
        self.assertEqual(switch.call_count, 2)

    def test_scene_restart_allows_new_id_epoch_but_requires_new_timestamp(self):
        previous = self.camera.last_frame[False]['timestamp_ns']
        load_library = self.backend.lib.tuning_load
        def switched(*args):
            result = load_library(*args)
            self.backend.id = 0
            return result
        self.backend.lib.x5w_tuning_load = Function(switched)
        frame = self.backend.frame
        def new_frame(raw=False):
            data, info = frame(raw)
            info['timestamp_ns'] = previous + info['frame_id']
            return data, info
        self.backend.frame = new_frame
        blob = b'{"bright":24}'
        inputs = {'contentBase64':base64.b64encode(blob).decode(), 'sha256':hashlib.sha256(blob).hexdigest()}
        result = self.camera.execute('tuning_load', inputs)
        self.assertEqual(result['evidence']['streamVerification']['status'], 'verified')
        floor = self.camera.last_frame[False]['timestamp_ns']
        self.backend.frame = lambda raw=False:(b'\x40'*4+b'\x80\x80', dict(width=2,height=2,stride_y=2,stride_uv=2,size_y=4,size_uv=2,bit_depth=8,bayer=0,packing=3,alignment=0,timestamp_ns=floor,frame_id=1))
        with self.assertRaisesRegex(camera.NativeError, 'camera_frame_stale'):
            self.camera.execute('tuning_load', inputs)
        self.assertTrue(self.camera.cleanup_required)
        self.assertTrue(self.camera.unconfirmed)

    def test_scene_success_then_restore_module_error_keeps_flow_cleanup_fence(self):
        original = self.config_now()
        blob=b'{"bright":24}'
        self.camera.execute('tuning_load',{'contentBase64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()})
        candidate = copy.deepcopy(original)
        candidate['modules']['awb']['manual_attr.gain.rgain'] = 2
        self.camera.apply_full(candidate)
        self.backend.lib.fail_module = 1
        with self.assertRaisesRegex(camera.NativeError, 'isp_module_write_failed'):
            self.camera.apply_full(original, True)
        self.assertTrue(self.camera.cleanup_required)
        count = len(self.backend.lib.loads)
        self.camera.close()
        self.assertEqual(len(self.backend.lib.loads), count)
    def test_effect_invalid_hash_json_path_inputs_fail_before_sdk(self):
        for inputs in ({'contentBase64':'e30=','sha256':'f'*64},{'contentBase64':base64.b64encode(b'[]').decode(),'sha256':hashlib.sha256(b'[]').hexdigest()},{'path':'/etc/shadow'}):
            with self.assertRaises(ValueError):self.camera.execute('tuning_load',inputs)
        self.assertEqual(self.backend.lib.loads,[])
    def test_ccm_awb_lsc_calibration_maps_and_reads_real_fixture_sdk_fields(self):
        ccm=self.result('ccm',[[1.2,0,0],[0,1,0],[0,0,.9]])
        result=self.camera.execute('calibration_apply',{'result':ccm,'options':{}});self.assertEqual(result['evidence']['config']['modules']['ccm']['manual_attr.cc_matrix'][0],ctypes.c_float(1.2).value)
        wb=self.result('awb',[{'illuminantId':'day','redGain':1.7,'greenGain':1,'blueGain':1.2}])
        result=self.camera.execute('calibration_apply',{'result':wb,'options':{'illuminantId':'day'}});self.assertEqual(result['evidence']['config']['modules']['awb']['manual_attr.gain.rgain'],ctypes.c_float(1.7).value)
        lsc=self.result('lsc',{k:[[1,2],[2,3]] for k in ('R','Gr','Gb','B')},grid={'xCentersNormalized':[.25,.75],'yCentersNormalized':[.25,.75]})
        result=self.camera.execute('calibration_apply',{'result':lsc,'options':{}});self.assertEqual(result['evidence']['config']['modules']['lsc']['manual_attr.matrix'][:6],[1024,1536,2048,2048,2560,3072])
    def test_blc_uses_real_library_api_and_does_not_fabricate_blc_getter(self):
        result=self.camera.execute('calibration_apply',{'result':self.result('blc',dict(R=10,Gr=11,Gb=12,B=13)),'options':{}})
        self.assertEqual(json.loads(self.backend.lib.loads[-1])['blc'],[10,11,12,13]);self.assertFalse(result['calibrationEvidence']['fullFieldReadbackAvailable'])
    def test_calibration_without_binding_or_wrong_illuminant_is_not_success_placeholder(self):
        del self.backend.isp.config['calibrationBindings']['ccm']
        with self.assertRaisesRegex(ValueError,'binding_required'):self.camera.execute('calibration_apply',{'result':self.result('ccm',[[1,0,0],[0,1,0],[0,0,1]])})
        with self.assertRaisesRegex(ValueError,'selection_required'):self.camera.execute('calibration_apply',{'result':self.result('awb',[])})
        self.assertEqual(self.backend.lib.writes,[])
    def raw_input(self):
        data=struct.pack('=4H',64,64,64,64);tuning=self.config_now()
        return {'tuning':tuning,'tuningHash':camera.digest(tuning),'raw':{'filename':'fixture.raw','contentBase64':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest(),'metadata':{'width':2,'height':2,'bitDepth':10,'bayer':'RGGB','packing':'unpacked16le','stride':4}}}
    def test_raw_replay_receipt_binds_input_and_actual_tuning_and_outputs_png(self):
        self.camera.config['modeReadbackEvidence']['exposure']='fixture/private-sdk-mode-roundtrip'
        inputs=self.raw_input();result=self.camera.execute('process_raw',inputs)
        self.assertEqual(result['rawHash'],inputs['raw']['sha256']);self.assertEqual(result['readbackHash'],camera.digest(self.backend.isp.read()));self.assertEqual(result['evidence']['timestampSource'],'submitted_host_time_echoed_by_sdk');self.assertTrue(base64.b64decode(result['contentBase64']).startswith(b'\x89PNG'))
    def test_raw_hash_bad_layout_and_failed_cleanup_never_admit_new_write(self):
        self.camera.config['modeReadbackEvidence']['exposure']='fixture/private-sdk-mode-roundtrip'
        inputs=self.raw_input();inputs['raw']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):self.camera.execute('process_raw',inputs)
        self.backend.replay_fails=True;self.backend.cleanup_fails=True
        with self.assertRaises(camera.NativeError):self.camera.execute('process_raw',self.raw_input())
        self.assertTrue(self.camera.cleanup_required)
        with self.assertRaisesRegex(camera.NativeError,'cleanup_required'):self.camera.execute('controls_set',{'values':{'brightness':1}})

    def test_failed_replay_cleanup_remains_fenced_after_daemon_restart(self):
        self.camera.config['modeReadbackEvidence']['exposure'] = 'fixture/private-sdk-mode-roundtrip'
        self.backend.replay_fails = True
        self.backend.cleanup_fails = True
        with self.assertRaises(camera.NativeError):
            self.camera.execute('process_raw', self.raw_input())
        restarted = camera.Camera(self.config, backend=self.backend, preflight=lambda:{})
        self.assertTrue(restarted.cleanup_required)
        self.assertIsNone(restarted.original)
        with self.assertRaisesRegex(camera.NativeError, 'camera_stream_cleanup_required'):
            restarted.execute('controls_set', {'values':{'brightness':1}})
        # Stop must use the native stop's non-restarting cleanup, even while
        # the separate replay_cleanup (which restarts live flow) still fails.
        self.backend.stop = mock.Mock()
        restarted.execute('preview_stop', {})
        self.backend.stop.assert_called_once()
        self.assertFalse(restarted.cleanup_required)
        again = camera.Camera(self.config, backend=self.backend, preflight=lambda:{})
        self.assertFalse(again.cleanup_required)
        self.assertFalse(again.unconfirmed)
        again.execute('controls_set', {'values':{'brightness':1}})
    def test_raw_replay_requires_both_private_mode_qualifications_before_sdk(self):
        inputs=self.raw_input();before=(self.backend.lib.gets,len(self.backend.lib.writes),self.backend.id)
        with self.assertRaisesRegex(ValueError,'mode_qualification_required'):self.camera.execute('process_raw',inputs)
        self.assertEqual((self.backend.lib.gets,len(self.backend.lib.writes),self.backend.id),before);self.assertEqual(getattr(self.backend,'replay_calls',0),0)
        self.camera.config['modeReadbackEvidence']['exposure']='fixture/private-sdk-mode-roundtrip';del self.camera.config['modeReadbackEvidence']['awb']
        with self.assertRaisesRegex(ValueError,'mode_qualification_required'):self.camera.execute('process_raw',inputs)
        self.assertEqual(getattr(self.backend,'replay_calls',0),0)
    def test_raw_replay_equal_current_tuning_does_not_bypass_unknown_write_or_cleanup(self):
        self.camera.config['modeReadbackEvidence']['exposure']='fixture/private-sdk-mode-roundtrip';inputs=self.raw_input()
        self.camera.unconfirmed=True
        with self.assertRaisesRegex(ValueError,'restore_required'):self.camera.execute('process_raw',inputs)
        self.camera.unconfirmed=False;self.camera.cleanup_required=True
        with self.assertRaisesRegex(camera.NativeError,'cleanup_required'):self.camera.execute('process_raw',inputs)
        self.assertEqual(getattr(self.backend,'replay_calls',0),0);self.assertEqual(self.backend.lib.writes,[])
    def test_raw_invalid_container_pixels_reject_before_applying_requested_tuning(self):
        self.camera.config['modeReadbackEvidence']['exposure']='fixture/private-sdk-mode-roundtrip';inputs=self.raw_input()
        inputs['tuning']['modules']['cproc']['manual_attr.bright']=20;inputs['tuningHash']=camera.digest(inputs['tuning'])
        data=struct.pack('=4H',1024,64,64,64);inputs['raw'].update(contentBase64=base64.b64encode(data).decode(),sha256=hashlib.sha256(data).hexdigest())
        with self.assertRaisesRegex(ValueError,'pixel_out_of_range'):self.camera.execute('process_raw',inputs)
        self.assertEqual(self.backend.lib.writes,[]);self.assertEqual(getattr(self.backend,'replay_calls',0),0);self.assertFalse(self.camera.changed);self.assertFalse(self.camera.unconfirmed)
    def test_private_config_rejects_invented_policies_nonfinite_bounds_and_request_schema(self):
        invalid=dict(self.config,awbGainLimits={'min':.5,'max':float('inf'),'evidenceRef':'fiction'})
        with self.assertRaises(ValueError):camera.validate_config(invalid)
        with self.assertRaisesRegex(ValueError,'invalid_inputs'):self.camera.execute('calibration_apply',{'result':{},'nativeStruct':'AAAA'})

if __name__=='__main__':unittest.main(verbosity=2)
