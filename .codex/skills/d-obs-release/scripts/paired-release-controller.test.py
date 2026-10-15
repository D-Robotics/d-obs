#!/usr/bin/env python3
"""Isolated filesystem/controller tests. Never run systemctl or modify a production path."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('paired_controller', Path(__file__).with_name('paired-release-controller.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

class ReleaseControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='paired-controller-fixture-')
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, data, mode=0o600):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def fake_root_regular(self, path, private=False, uid=0, max_bytes=64*1024*1024):
        data, info = self.real_regular(path, private=private, uid=os.getuid(), max_bytes=max_bytes)
        values = list(info); values[4] = values[5] = 0
        return data, os.stat_result(values)

    def controller(self):
        obj = c.Controller.__new__(c.Controller)
        obj.config_hash = 'c'*64
        obj.journal_dir = self.root / 'journal';obj.journal_dir.mkdir(mode=0o700)
        obj.journal_path = obj.journal_dir / 'controller-journal.json'
        obj.env_file = self.root / 'etc/rdk-camera-account-bridge.env'
        obj.state_dir = self.root / 'state'
        obj.systemd_dir = self.root / 'etc/systemd/system'
        obj.config = {'taskId':'software-fixture','units': {role:{'name':role+'.service','healthUrls':['http://127.0.0.1:1/healthz']} for role in ('dobs','standby','primary')},'components':{}}
        for name in ('dobs','studio'):
            base=self.root/name/'base';candidate=self.root/name/'candidate';base.mkdir(parents=True);candidate.mkdir()
            current=base.parent/'current';current.symlink_to(candidate)
            obj.config['components'][name]={'base':str(base),'candidate':str(candidate),'current':str(current),'files':{},'baselineFiles':{},'manifestName':'fixture-manifest.json','manifestSha256':'a'*64}
        obj.journal={'phase':'active','configSha256':obj.config_hash,'units':{role:{} for role in ('dobs','standby','primary')},'externalBefore':{},'plannedHashes':{},'changed':[],'originalLinks':{name:row['base'] for name,row in obj.config['components'].items()}}
        return obj

    def test_hardlink_overlay_unlinks_before_copy(self):
        base=self.root/'base';candidate=self.root/'candidate';base.mkdir();candidate.mkdir()
        original=base/'main.js';original.write_bytes(b'old bytes');os.link(original,candidate/'main.js')
        inode=original.stat().st_ino
        c.payload_copy(candidate,'main.js',b'new bytes')
        self.assertEqual(original.read_bytes(),b'old bytes');self.assertEqual(original.stat().st_ino,inode)
        self.assertNotEqual((candidate/'main.js').stat().st_ino,inode)

    def test_payload_parent_symlinks_and_traversal_cannot_escape(self):
        candidate=self.root/'candidate';outside=self.root/'outside';candidate.mkdir();outside.mkdir();(candidate/'escape').symlink_to(outside,target_is_directory=True)
        for name in ('../outside/file','/absolute','escape/file'):
            with self.assertRaises(c.ReleaseError):c.payload_copy(candidate,name,b'forbidden')
        self.assertEqual(list(outside.iterdir()),[])

    def test_new_nested_namespace_validation_never_creates_baseline_ancestors(self):
        obj=self.controller();component=obj.config['components']['studio']
        base=Path(component['base']);candidate=Path(component['candidate']);current=Path(component['current']);current.unlink();current.symlink_to(base)
        existing=base/'main.js';existing.write_bytes(b'live baseline bytes')
        name='dist/assets/camera-native-account/session/runtime.js'
        component['files']={name:c.digest(b'new candidate bytes')};component['baselineFiles']={'main.js':c.digest(existing.read_bytes())}
        before=(existing.stat().st_ino,existing.read_bytes(),sorted(str(p.relative_to(base)) for p in base.rglob('*')))
        obj.validate_baseline(component)
        self.assertFalse((base/'dist').exists())
        self.assertEqual((existing.stat().st_ino,existing.read_bytes(),sorted(str(p.relative_to(base)) for p in base.rglob('*'))),before)
        c.payload_copy(candidate,name,b'new candidate bytes')
        self.assertEqual((candidate/name).read_bytes(),b'new candidate bytes');self.assertFalse((base/'dist').exists())
        outside=self.root/'outside';outside.mkdir();(base/'dist').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(c.ReleaseError):obj.validate_baseline(component)
        self.assertEqual(list(outside.iterdir()),[])
        (base/'dist').unlink();(base/'dist').symlink_to(base/'missing-target')
        with self.assertRaises(c.ReleaseError):obj.validate_baseline(component)
        (base/'dist').unlink();(base/'dist').write_bytes(b'not a directory')
        with self.assertRaises(c.ReleaseError):obj.validate_baseline(component)
        for invalid in ('../escape/runtime.js','dist/../escape/runtime.js','/absolute/runtime.js'):
            component['files']={invalid:'a'*64}
            with self.assertRaises(c.ReleaseError):obj.validate_baseline(component)

    def test_pointer_switch_requires_the_expected_current(self):
        base=self.root/'base';candidate=self.root/'candidate';later=self.root/'later'
        for folder in (base,candidate,later):folder.mkdir()
        link=self.root/'current';link.symlink_to(base);c.switch_pointer(link,base,candidate)
        self.assertEqual(link.resolve(),candidate)
        link.unlink();link.symlink_to(later)
        with self.assertRaises(c.ReleaseError):c.switch_pointer(link,candidate,base)
        self.assertEqual(link.resolve(),later)

    def test_private_files_are_owned_exact_mode_and_never_symlinks(self):
        file=self.write('private.json',b'{}')
        self.assertEqual(c.regular(file,private=True,uid=os.getuid())[0],b'{}')
        file.chmod(0o644)
        with self.assertRaises(c.ReleaseError):c.regular(file,private=True,uid=os.getuid())
        file.chmod(0o600);alias=self.root/'alias';alias.symlink_to(file)
        with self.assertRaises(OSError):c.regular(alias,private=True,uid=os.getuid())

    def test_atomic_file_replaces_a_hardlink_without_changing_its_source(self):
        old=self.write('old',b'old');target=self.root/'new';os.link(old,target)
        c.atomic_file(target,b'updated')
        self.assertEqual(old.read_bytes(),b'old');self.assertEqual(target.read_bytes(),b'updated');self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o600)

    def test_health_urls_are_source_numeric_loopback_or_public_https(self):
        for url in ('http://127.0.0.1:18093/healthz','http://[::1]:8080/readyz'):
            c.health_url(url,source=True)
        c.health_url('https://studio.example/healthz')
        for url in ('http://localhost/healthz','http://192.0.2.1/healthz','https://127.0.0.1/healthz','http://127.0.0.1/healthz?token=private','http://user@127.0.0.1/healthz','http://127.0.0.1/health z'):
            with self.assertRaises((c.ReleaseError,ValueError)):c.health_url(url,source=True)
        with self.assertRaises(c.ReleaseError):c.health_url('http://127.0.0.1/healthz')

    def test_current_must_remain_an_owned_symlink(self):
        obj=self.controller();obj.owned_currents()
        current=Path(obj.config['components']['dobs']['current']);current.unlink();current.mkdir()
        with self.assertRaises(c.ReleaseError):obj.owned_currents()

    def test_planned_configuration_checks_modes_as_well_as_bytes(self):
        obj=self.controller();targets=[('shared-env',obj.env_file)]+[('dropin-'+role,obj.dropin(role)) for role in obj.config['units']]
        for label,target in targets:
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(label.encode());target.chmod(0o600 if label=='shared-env' else 0o644);obj.journal['plannedHashes'][label]=c.digest(target.read_bytes())
        self.real_regular=c.regular
        with patch.object(c,'regular',self.fake_root_regular):
            obj.planned_configuration();obj.env_file.chmod(0o644)
            with self.assertRaises(c.ReleaseError):obj.planned_configuration()

    def test_mismatched_proof_stops_before_key_generation(self):
        obj=self.controller();obj.journal['phase']='prepared'
        obj.load=lambda:None;obj.validate_baseline=lambda x:None;obj.validate_candidate=lambda x:None
        obj.check_proof=lambda *args:c.need(False,'candidate_proof_artifacts_mismatch')
        with patch.object(c.secrets,'token_hex') as generation,patch.object(c,'run') as run:
            with self.assertRaises(c.ReleaseError):obj.activate({'dobs':{},'studio':{}})
            generation.assert_not_called();run.assert_not_called()
        self.assertFalse(obj.env_file.exists())

    def test_proof_binds_exact_candidate_files_nodes_and_log(self):
        obj=self.controller();component=obj.config['components']['dobs'];component['files']={'server/main.js':'d'*64}
        obj.journal['units']['dobs']={'nodeExecutable':'/node/production','nodeVersion':'v22.19.0'}
        log=self.write('test.log',b'actual isolated test evidence')
        proof={'schema':c.PROOF_SCHEMA,'component':'dobs','candidate':component['candidate'],'manifestSha256':component['manifestSha256'],'files':component['files'],'pairedCandidates':{name:{'candidate':row['candidate'],'manifestSha256':row['manifestSha256']} for name,row in obj.config['components'].items()},'testExitCode':0,'productionStateWrites':0,'hardwareOperations':0,'checks':{'moduleTests':True,'readOnlySmoke':True,'pairedAccountBridgeSmoke':True},'nodes':[{'executable':'/node/production','version':'v22.19.0','testExitCode':0}],'testLogPath':str(log),'testLogSha256':c.digest(log.read_bytes())}
        self.real_regular=c.regular
        with patch.object(c,'regular',self.fake_root_regular):
            def checked(value):
                file=self.write('proof.json',json.dumps(value).encode());obj.check_proof('dobs',{'path':str(file),'sha256':c.digest(file.read_bytes())})
            checked(proof)
            component['requiredChecks']=['frontendPreserved'];component['requiredEvidence']={'namespaceQa':'e'*64}
            with self.assertRaises(c.ReleaseError):checked(proof)
            checked({**proof,'checks':{**proof['checks'],'frontendPreserved':True},'evidenceSha256':{'namespaceQa':'e'*64}})
            component.pop('requiredChecks');component.pop('requiredEvidence')
            for modified in ({**proof,'candidate':'/other/candidate'},{**proof,'files':{}},{**proof,'pairedCandidates':{}},{**proof,'checks':{'moduleTests':True,'readOnlySmoke':True}},{**proof,'testExitCode':1},{**proof,'productionStateWrites':False},{**proof,'nodes':proof['nodes']+[{'executable':'/node/production','version':'v22.19.0','testExitCode':1}]},{**proof,'testLogSha256':'0'*64}):
                with self.assertRaises(c.ReleaseError):checked(modified)

    def test_rollback_refuses_later_release_before_touching_configuration(self):
        obj=self.controller();later=self.root/'dobs/later';later.mkdir();link=Path(obj.config['components']['dobs']['current']);link.unlink();link.symlink_to(later)
        with patch.object(c,'run') as run:
            with self.assertRaises(c.ReleaseError):obj.rollback()
            run.assert_not_called()
        self.assertEqual(link.resolve(),later)

    def test_rollback_preserves_a_later_configuration_change(self):
        obj=self.controller();obj.env_file.parent.mkdir(parents=True);obj.env_file.write_bytes(b'later deployment content');obj.env_file.chmod(0o600)
        obj.journal['externalBefore']['shared-env']={'exists':False};obj.journal['plannedHashes']['shared-env']=c.digest(b'our earlier content')
        self.real_regular=c.regular
        with patch.object(c,'regular',self.fake_root_regular),patch.object(c,'run') as run:
            with self.assertRaises(c.ReleaseError):obj.rollback()
            run.assert_not_called()
        self.assertEqual(obj.env_file.read_bytes(),b'later deployment content')

    def test_rollback_rechecks_all_currents_between_mutations(self):
        obj=self.controller();later=self.root/'studio/later';later.mkdir()
        for label in ['shared-env']+['dropin-'+role for role in obj.config['units']]:obj.journal['externalBefore'][label]={'exists':False}
        original=c.switch_pointer
        def switch_and_later(current,expected,target):
            original(current,expected,target)
            studio=Path(obj.config['components']['studio']['current']);studio.unlink();studio.symlink_to(later)
        with patch.object(c,'switch_pointer',switch_and_later),patch.object(c,'run') as commands:
            with self.assertRaises(c.ReleaseError):obj.rollback()
            commands.assert_not_called()
        self.assertEqual(Path(obj.config['components']['studio']['current']).resolve(),later)

    def test_rollback_restores_only_real_backup_and_removes_own_new_dropins(self):
        obj=self.controller();old=b'EXISTING_PRIVATE_SETTING=fixture-old\n';new=b'RDK_VISION_BRIDGE_SECRET=fixture-not-a-real-key\n'
        obj.journal['originalLinks']['studio']='base'
        obj.env_file.parent.mkdir(parents=True);obj.env_file.write_bytes(new);obj.env_file.chmod(0o600)
        backup=self.write('old-env.backup',old)
        obj.journal['externalBefore']['shared-env']={'exists':True,'sha256':c.digest(old),'mode':0o600,'uid':0,'gid':0,'backup':str(backup)};obj.journal['plannedHashes']['shared-env']=c.digest(new)
        for role in obj.config['units']:
            dropin=obj.dropin(role);dropin.parent.mkdir(parents=True);data=b'[Service]\nEnvironmentFile=/fixture/shared.env\n';dropin.write_bytes(data);dropin.chmod(0o644)
            obj.journal['externalBefore']['dropin-'+role]={'exists':False};obj.journal['plannedHashes']['dropin-'+role]=c.digest(data)
        self.real_regular=c.regular
        obj.inspect_unit=lambda role:{'cwd':obj.config['components']['dobs' if role=='dobs' else 'studio']['base']}
        with patch.object(c,'regular',self.fake_root_regular),patch.object(c,'run',return_value=b'') as commands,patch.object(c,'health'),patch.object(c.os,'chown'):
            obj.rollback()
            self.assertTrue(commands.called)
        self.assertEqual(obj.env_file.read_bytes(),old);self.assertEqual(obj.journal['phase'],'rolled_back')
        for role in obj.config['units']:self.assertFalse(obj.dropin(role).exists())
        for component in obj.config['components'].values():self.assertEqual(Path(component['current']).resolve(),Path(component['base']))
        self.assertEqual(os.readlink(obj.config['components']['studio']['current']),'base')

if __name__=='__main__':
    unittest.main(verbosity=2)
