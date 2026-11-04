"""Independent reference/golden/equivalence checks; private handoff stays in .data."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'resources/image-quality/v1.23.0'
sys.path.insert(0, str(ASSETS))
import reference_scoring as ref
import worker

# Importing the bounded worker also imports the reference; functions are replaced
# only by worker.main(), so the baseline remains untouched in this test process.
parser = argparse.ArgumentParser()
parser.add_argument('--handoff', type=Path)
parser.add_argument('--large-manifest', type=Path)
args, unittest_args = parser.parse_known_args()


def execute(file):
    result = subprocess.run([sys.executable, '-B', str(ASSETS / 'worker.py')],
        input=json.dumps({'imagePath': str(file)}), text=True, capture_output=True,
        timeout=120, env={**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1'})
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class PixelChecks(unittest.TestCase):
    def test_01_parameters_and_untouched_reference(self):
        self.assertEqual(hashlib.sha256((ASSETS/'reference_scoring.py').read_bytes()).hexdigest(),
                         'd5d076e012a85b764e3cbc6e9c2ccb0c43c6228e65a90b49b499a8d57cd8c27c')
        config = json.loads((ASSETS/'config.json').read_text())
        self.assertEqual(ref.DIMENSIONS, config['weights'])
        self.assertEqual(sum(ref.DIMENSIONS.values()), 97)
        self.assertEqual(ref.CAPS, config['caps'])
        self.assertEqual(ref.ALERT_THRESHOLD, config['alertThreshold'])
        self.assertEqual(ref.GOOD_THRESHOLD, config['goodThreshold'])
        self.assertEqual(ref.CALIBRATION_OFFSET, config['offset'])
        curves = json.loads((ASSETS/'calibration_curves.json').read_text())['curves']
        self.assertEqual(set(curves), {'clarity'})
        for dim, params in ref.CURVES.items():
            self.assertEqual(params, {k: curves[dim][k] for k in params})

    def test_02_tiled_median_and_boundaries(self):
        rng = np.random.default_rng(20261027)
        for h, w in [(1,1),(2,17),(17,17),(128,257),(2049,513)]:
            pixels = rng.integers(0,256,size=(h,w,3)).astype(np.float64)
            channels = [pixels[:,:,k] for k in range(3)]
            with self.subTest(shape=(h,w)):
                self.assertEqual(ref.measure_damage(*channels), worker.damage_tiled(*channels))

    def test_03_gray_cast_alpha_and_accepted_ui_behavior(self):
        rng = np.random.default_rng(1)
        gray = rng.integers(0,256,size=(129,257),dtype=np.uint8)
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder)/'image.png'
            for name, image, color in [
                ('gray', Image.fromarray(gray).convert('RGB'),100),
                ('red', Image.new('RGB',(128,128),(255,0,0)),15),
                ('white', Image.new('RGB',(128,128),'white'),100),
                ('alpha', Image.new('RGBA',(128,128),(0,0,0,0)),100),
            ]:
                with self.subTest(name=name):
                    image.save(file)
                    baseline = ref.score_image(str(file))
                    actual = execute(file)
                    self.assertEqual(actual, baseline)
                    self.assertEqual(actual['dimension_scores']['color'],color)
                    if name in ['white','alpha']:
                        self.assertTrue(actual['analysis']['composition']['metrics']['is_ui_rendered'])
                        self.assertEqual(actual['status'],'alert')
            image=Image.new('RGBA',(48,65),(100,80,60,100))
            flattened=Image.alpha_composite(Image.new('RGBA',image.size,'white'),image).convert('RGB')
            for a,b in zip(ref.prepare(image),ref.prepare(flattened)):
                np.testing.assert_array_equal(a,b)

    def test_04_determinism_and_path_independence(self):
        with tempfile.TemporaryDirectory() as folder:
            a,b=Path(folder)/'a.png',Path(folder)/'other-name.png'
            Image.new('RGB',(129,257),(100,100,100)).save(a)
            b.write_bytes(a.read_bytes())
            self.assertEqual(execute(a),execute(a))
            self.assertEqual(execute(a),execute(b))

    def test_05_thresholds_cap_order_and_error_markers(self):
        original=ref.analyze_image
        try:
            with tempfile.TemporaryDirectory() as folder:
                file=Path(folder)/'test.png';Image.new('RGB',(32,32),'gray').save(file)
                def values(score,damage=None):
                    return {k:{'score':damage if k=='damage' and damage is not None else score,
                               'method':'real','metrics':{}} for k in ref.DIMENSIONS}
                for score,status in [(79.9,'alert'),(79.96,'alert'),(80,'warning'),(95,'good')]:
                    ref.analyze_image=lambda img,s=score:values(s)
                    self.assertEqual(ref.score_image(str(file),curves={})['status'],status)
                ref.analyze_image=lambda img:values(100,29)
                result=ref.score_image(str(file),curves={},offset=10)
                self.assertEqual(result['final_score'],90)
                self.assertIn('detail_unacceptable',result['triggered_caps'])
        finally:
            ref.analyze_image=original
        original_fn=ref.MEASURERS['color']
        def fail(*args): raise MemoryError('intentional dimension failure')
        try:
            ref.MEASURERS['color']=fail
            failed=ref.analyze_image(Image.new('RGB',(32,32),'gray'))['color']
            self.assertEqual(failed['score'],70)
            self.assertEqual(failed['method'],'error')
        finally:
            ref.MEASURERS['color']=original_fn

    @unittest.skipUnless(args.handoff,'Pass --handoff to require all six customer golden fixtures')
    def test_06_customer_golden_scores(self):
        text=(args.handoff/'expected_scores.md').read_text()
        labels={'清晰度':'clarity','分辨率':'resolution','构图':'composition','完整性':'completeness',
                '色彩':'color','损坏':'damage','曝光':'exposure'}
        sections=re.split(r'^## ',text,flags=re.M)[1:]
        self.assertEqual(len(sections),6)
        for section in sections:
            name=section.splitlines()[0].strip()
            with self.subTest(image=name):
                result=execute(args.handoff/'sample_images'/name)
                for label,raw,cal in re.findall(r'^\|\s*([^|]+?)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|',section,flags=re.M):
                    if label.strip() in labels:
                        key=labels[label.strip()]
                        self.assertEqual(result['dimension_scores'][key],float(raw))
                        self.assertEqual(result['calibrated_dimension_scores'][key],float(cal))
                for label,key in [('原始加权总分','raw_weighted_score'),('校准后加权总分','weighted_score_before_cap'),('最终分','final_score')]:
                    self.assertEqual(result[key],float(re.search(label+r'：([0-9.]+)',section).group(1)))
                caps=re.search(r'Cap 触发：([^\n]+)',section).group(1).strip()
                self.assertEqual(result['triggered_caps'],[] if caps=='无' else [c.strip() for c in caps.split(',')])
                self.assertEqual(result['status'],'alert' if '（不通过）' in section else 'warning' if '（警告）' in section else 'good')
                self.assertFalse(any(v['method']=='error' for v in result['analysis'].values()))

    @unittest.skipUnless(args.large_manifest,'Pass --large-manifest for actual large-Library verification')
    def test_07_large_library_references(self):
        manifest=json.loads(args.large_manifest.read_text())
        self.assertEqual(len(manifest),4)
        for item in manifest:
            file=args.large_manifest.parent/item['file']
            with self.subTest(image=item['file']):
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(),item['sha256'])
                self.assertEqual(execute(file),item['expected'])
                self.assertFalse(any(v['method']=='error' for v in item['expected']['analysis'].values()))


if __name__=='__main__':
    unittest.main(argv=[sys.argv[0],*unittest_args],verbosity=2)
