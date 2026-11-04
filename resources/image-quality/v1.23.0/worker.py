"""Resource-bounded adapter. The customer's reference_scoring.py stays unchanged."""
import ctypes
import json
import os
from pathlib import Path
import signal
import sys

# Must precede NumPy imports: large default BLAS thread pools reserve address space.
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
sys.dont_write_bytecode = True

if sys.platform.startswith('linux'):
    import resource
    parent = os.getppid()
    # A restarted Node service must not leave an orphan scoring process behind.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot install parent-death signal')
    if os.getppid() != parent:
        sys.exit(1)
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024 ** 3, 2 * 1024 ** 3))

import reference_scoring as ref
import numpy as np


def damage_tiled(r, g, b):
    """Same formulas/padding/reductions; only the median's scratch array is tiled."""
    gray = ref.luma(r, g, b)
    mask = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float64) / 6.0
    h, w = gray.shape
    if h > 2 and w > 2:
        pad = np.pad(gray, 1, mode='edge')
        conv = np.zeros_like(gray)
        for dy in range(3):
            for dx in range(3):
                conv += mask[dy, dx] * pad[dy:dy + h, dx:dx + w]
        noise_sigma = float(np.sqrt(np.pi / 2) * np.abs(conv).mean())
    else:
        noise_sigma = 0.0
    block_ratio = 1.0
    if h > 16 and w > 16:
        col_diff = np.abs(np.diff(gray, axis=1))
        boundary_cols = np.arange(7, w - 1, 8)
        inner_cols = np.array([c for c in range(w - 1) if (c % 8) != 7])
        if len(boundary_cols) and len(inner_cols):
            block_ratio = float(col_diff[:, boundary_cols].mean() / (col_diff[:, inner_cols].mean() + 1e-9))
    if h > 2 and w > 2:
        pad = np.pad(gray, 1, mode='edge')
        impulse_count = 0
        tile_rows = max(1, 262144 // w)
        for row in range(0, h, tile_rows):
            end = min(h, row + tile_rows)
            stack = np.stack([pad[dy + row:dy + end, dx:dx + w] for dy in range(3) for dx in range(3)])
            median = np.median(stack, axis=0, overwrite_input=True)
            impulse_count += int(np.count_nonzero(np.abs(gray[row:end] - median) > 40))
        impulse_pct = float(impulse_count) / gray.size * 100.0
    else:
        impulse_pct = 0.0
    noise_score = ref.clamp(ref.piecewise(noise_sigma, [
        (0.3, 100.0), (1.0, 96.0), (2.0, 88.0), (4.0, 72.0), (8.0, 50.0), (18.0, 28.0), (40.0, 10.0)]))
    block_score = ref.clamp(ref.piecewise(block_ratio, [
        (1.0, 100.0), (1.15, 85.0), (1.4, 60.0), (1.8, 35.0), (2.5, 15.0)]))
    impulse_score = ref.clamp(100 - impulse_pct * 8.0)
    score = 0.45 * noise_score + 0.30 * block_score + 0.25 * impulse_score
    return {
        'score': round(ref.clamp(score), 1), 'method': 'real', 'method_label': '真实测量',
        'metrics': {'noise_sigma': round(noise_sigma, 2), 'blockiness_ratio': round(block_ratio, 3),
                    'impulse_noise_pct': round(impulse_pct, 3)},
        'notes': 'Immerkaer噪声估计 + JPEG块效应边界比 + 椒盐离群点比例',
    }


def main():
    request = json.load(sys.stdin)
    root = Path(__file__).parent
    config = json.loads((root / 'config.json').read_text())
    curves = json.loads((root / 'calibration_curves.json').read_text())['curves']
    # One source of runtime configuration; the untouched reference is also tested
    # against these values to detect a mismatched handoff.
    ref.DIMENSIONS = config['weights']
    ref.CAPS = config['caps']
    ref.ALERT_THRESHOLD = config['alertThreshold']
    ref.GOOD_THRESHOLD = config['goodThreshold']
    ref.MEASURERS['damage'] = damage_tiled
    result = ref.score_image(request['imagePath'], curves=curves, offset=config['offset'])
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
