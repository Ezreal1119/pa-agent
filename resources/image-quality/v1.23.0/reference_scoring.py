#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图片质量评分体系 V1.23.0 —— 单文件参考实现（可直接运行）

用法：
    python reference_scoring.py <图片路径> [更多图片...]
    python reference_scoring.py --json <图片路径>     # 输出完整 JSON（含维度明细）

依赖：numpy、Pillow。不需要视觉模型、GPU、网络。

与线上系统的关系：
    本文件是「图片质量评分系统」V1.23.0 的独立复刻实现，算法、参数、
    校准曲线与线上 config/scoring_config.yaml 完全一致。
    线上系统用 src/image_analysis.py + src/scoring_engine.py + src/calibration.py，
    本文件把这三者合并为一个自包含脚本，便于对方独立运行核对结果。

确定性保证：
    同一张图的像素永远得到同一个结果，与文件路径、文件名、评分次数无关。
    禁止任何随机源、哈希种子、时间种子。
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

# ==========================================================================
# 版本与参数（全部来自线上 config/scoring_config.yaml，V1.23.0）
# ==========================================================================

VERSION = '1.23.0'

# ---- 七维度权重（合计 97，加权时按总权重归一化）----
DIMENSIONS: Dict[str, int] = {
    'clarity': 20,        # 清晰度
    'resolution': 15,     # 分辨率与噪点
    'composition': 20,    # 构图与留白
    'completeness': 12,   # 内容完整性
    'color': 15,          # 色彩（缺陷旗标）
    'damage': 10,         # 画面损坏
    'exposure': 5,        # 亮度与曝光
}

# ---- 条件性 Cap（加权+offset 之后应用，取触发者中最严格的）----
CAPS: Dict[str, int] = {
    'key_content_unrecognizable': 100,   # completeness < 30
    'subject_blurrable': 100,            # 30 <= clarity < 60
    'blank_or_tiny_subject': 100,        # blank_ratio_pct > 80 且非文档/界面截图
    'detail_unacceptable': 90,           # clarity < 30 或 damage < 30
}

ALERT_THRESHOLD = 80
GOOD_THRESHOLD = 95
CALIBRATION_OFFSET = 0.0

# ---- 校准曲线（V1.23.0 生效）----
# V1.23.0 起新增「可信度闸门」：拟合不可信（R²<0.10）或 raw 斜率越界的维度
# 不再出曲线，走恒等映射（y=x）。旧版用 clamp 把越界斜率强行拉成 slope=0.2，
# 等于凭空造出一条拟合里不存在的曲线 —— exposure 会被压成 40→73.8、60→77.8，
# 而那条曲线的 R² 只有 0.005（毫无解释力）。
# 详见 docs 中的「校准曲线机制」章节。
CURVES: Dict[str, Dict[str, float]] = {
    'clarity': {'slope': 0.7808, 'intercept': 21.97, 'x_min': 31.7, 'x_max': 75.1},
}
# resolution / damage / composition / completeness / color / exposure 均无曲线 → 恒等映射

# ---- 算法常量 ----
GAUSSIAN_SIGMA = 0.5                 # 拉普拉斯前的高斯平滑尺度（LoG 化）
UI_UNIFORM_MIN_PCT = 20.0            # 渲染图：完全均匀像素占比下限
UI_PALETTE_TOP16_MIN_PCT = 80.0      # 渲染图：前 16 色覆盖率下限
UI_EXTREME_WB_DEV = 25.0              # 界面截图白平衡豁免上限
DOC_BG_FRAC_MIN = 55.0                # 文档/界面：主导背景色占比下限
DOC_EDGE_FRAC_MIN = 0.5              # 文档/界面：边缘像素占比下限

# ==========================================================================
# 基础工具
# ==========================================================================


def prepare(img: Image.Image) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """转成 float64 RGB 三通道；透明图按白底合成（否则拉普拉斯/熵全乱）。"""
    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
        bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    if img.mode != 'RGB':
        img = img.convert('RGB')
    arr = np.asarray(img, dtype=np.float64)
    return arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]


def luma(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rec.601 亮度"""
    return 0.299 * r + 0.587 * g + 0.114 * b


def laplacian(gray: np.ndarray) -> np.ndarray:
    """4 邻域拉普拉斯（只取内部区域，避免边缘填充伪影）"""
    c = gray[1:-1, 1:-1]
    return (4 * c - gray[:-2, 1:-1] - gray[2:, 1:-1]
            - gray[1:-1, :-2] - gray[1:-1, 2:])


def gaussian_smooth(gray: np.ndarray, sigma: float = GAUSSIAN_SIGMA) -> np.ndarray:
    """可分离高斯模糊（纯 numpy）。reflect 填充避免边缘暗角；sigma<=0 原样返回。

    作用：拉普拉斯前先压掉单像素噪声与 JPEG 伪影对高频能量的虚高，
    即把裸拉普拉斯变成 LoG。sigma=0.5 是 32 张标定样本重标定后的取值。
    """
    if sigma <= 0:
        return gray
    radius = max(1, int(round(3.0 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x ** 2) / (2.0 * sigma ** 2))
    k /= k.sum()
    h, w = gray.shape
    padded = np.pad(gray, ((radius, radius), (radius, radius)), mode='reflect')
    # 行卷积：padded(H+2r, W+2r) -> tmp(H+2r, W)
    tmp = np.empty((h + 2 * radius, w), dtype=gray.dtype)
    for i in range(h + 2 * radius):
        tmp[i] = np.convolve(padded[i], k, mode='valid')
    # 列卷积：tmp(H+2r, W) -> out(H, W)
    out = np.empty((h, w), dtype=gray.dtype)
    for j in range(w):
        out[:, j] = np.convolve(tmp[:, j], k, mode='valid')
    return out


def clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def piecewise(x: float, anchors: List[Tuple[float, float]]) -> float:
    """分段线性映射。anchors = [(输入值, 输出分), ...] 按输入升序。

    超出范围时按最近一段的斜率外推（由 clamp 兜住）。
    """
    if not anchors:
        return 0.0
    if x <= anchors[0][0]:
        x0, y0 = anchors[0]
        x1, y1 = anchors[1] if len(anchors) > 1 else (x0 + 1, y0 + 1)
        slope = (y1 - y0) / (x1 - x0) if x1 != x0 else 0
        return y0 + slope * (x - x0)
    for i in range(len(anchors) - 1):
        x0, y0 = anchors[i]
        x1, y1 = anchors[i + 1]
        if x <= x1:
            slope = (y1 - y0) / (x1 - x0) if x1 != x0 else 0
            return y0 + slope * (x - x0)
    x0, y0 = anchors[-2]
    x1, y1 = anchors[-1]
    slope = (y1 - y0) / (x1 - x0) if x1 != x0 else 0
    return y1 + slope * (x - x1)


def pct(a: np.ndarray, lo: float, hi: float) -> float:
    """数组落在 [lo, hi) 内的百分比"""
    if a.size == 0:
        return 0.0
    return float(np.count_nonzero((a >= lo) & (a < hi))) / a.size * 100.0


def ui_signal(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> Tuple[bool, float, float]:
    """渲染图/界面截图识别（纯像素统计，不需要语义模型）。

    两条互补的物理判据：
    - 完全均匀像素占比：相邻像素灰度差精确为 0 的比例。渲染图的纯色填充区
      是逐像素完全相同的；真实照片带传感器噪声与渐变，几乎不会出现。
    - 调色板集中度：RGB 各通道量化到 4bit（16 级）后，占比最大的 16 个颜色桶
      合计覆盖率。界面只有有限几种设计色（长尾极短）；照片是长尾分布。

    两条同时满足才判为渲染图（保守：避免把平滑天空/白墙照片误判）。
    返回 (is_ui, uniform_pct, top16_mass_pct)。
    """
    gray = luma(r, g, b)
    if gray.shape[0] < 2 or gray.shape[1] < 2:
        return False, 0.0, 0.0
    dx = np.abs(np.diff(gray, axis=1))[:-1, :]
    dy = np.abs(np.diff(gray, axis=0))[:, :-1]
    uniform_pct = float((np.maximum(dx, dy) <= 0.0).mean()) * 100.0
    code = (((r.astype(np.int32) >> 4) << 8)
            | ((g.astype(np.int32) >> 4) << 4)
            | (b.astype(np.int32) >> 4))
    cnt = np.bincount(code.ravel(), minlength=4096).astype(np.float64)
    total = float(cnt.sum()) + 1e-9
    top16 = float(np.sort(cnt)[-16:].sum()) / total * 100.0
    is_ui = bool(uniform_pct >= UI_UNIFORM_MIN_PCT and top16 >= UI_PALETTE_TOP16_MIN_PCT)
    return is_ui, uniform_pct, top16


def doc_signal(gray: np.ndarray,
               rgb: Optional[Tuple[np.ndarray, np.ndarray, np.ndarray]] = None):
    """文档/界面截图识别信号 —— 全系统【唯一】的判据来源。

    两条判据，命中任一即为界面/文档图：
    (1) 单一主导背景色（灰度直方图峰值 ±10）占比 > 55%，且边缘像素 > 0.5%
        —— 白底文档、单色背景的简洁界面；
    (2) 渲染图信号（ui_signal）：大片像素完全相同的色块 + 调色板高度集中
        —— 多面板 UI（白输入框 + 浅蓝面板 + 深蓝标题栏 + 彩色横幅）没有任何
        单一背景色过半，(1) 必然失手，靠 (2) 兜住。

    【V1.23.0】所有维度（exposure / color / composition / completeness）
    必须调用本函数取 is_doc，不得各自内联重算 —— 否则同一张图可能在
    曝光维度判为截图、在构图维度判为普通照片。

    返回 (bg_frac_pct, edge_frac_pct, is_doc, bg_lo, bg_hi,
          is_ui, uniform_pct, top16_mass_pct)。
    """
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    peak = int(hist.argmax())
    bg_lo, bg_hi = max(0, peak - 10), min(256, peak + 11)
    bg_frac = float(((gray >= bg_lo) & (gray < bg_hi)).mean()) * 100.0
    grad = np.zeros_like(gray)
    grad[:, :-1] += np.abs(np.diff(gray, axis=1))
    grad[:-1, :] += np.abs(np.diff(gray, axis=0))
    edge_frac = float((grad > 30.0).mean()) * 100.0
    is_single = bool(bg_frac > DOC_BG_FRAC_MIN and edge_frac > DOC_EDGE_FRAC_MIN)
    is_ui, uniform_pct, top16_mass = (False, 0.0, 0.0)
    if rgb is not None:
        is_ui, uniform_pct, top16_mass = ui_signal(*rgb)
    is_doc = bool(is_single or is_ui)
    return bg_frac, edge_frac, is_doc, bg_lo, bg_hi, is_ui, uniform_pct, top16_mass


# ==========================================================================
# 1. 清晰度 clarity（real，真实测量）
# ==========================================================================


def measure_clarity(r, g, b) -> Dict[str, Any]:
    """清晰度 = 高频能量。拉普拉斯方差（业界通用模糊度指标，越大越清晰）。

    注意：先做前置高斯平滑（LoG 化）再取拉普拉斯，抑制单像素噪声与 JPEG
    伪影对高频能量的虚高。σ=0.5。
    """
    gray = luma(r, g, b)
    gray_s = gaussian_smooth(gray, GAUSSIAN_SIGMA)
    lap = laplacian(gray_s)
    lap_var = float(np.var(lap))

    gx = float(np.abs(np.diff(gray, axis=1)).mean())
    gy = float(np.abs(np.diff(gray, axis=0)).mean())
    grad_mean = (gx + gy) / 2.0

    total_energy = float(np.sum(gray_s ** 2)) + 1e-9
    hf_ratio = float(np.sum(lap ** 2)) / total_energy * 100.0

    # 锚点由 32 张真实样本重标定（LoG σ=0.5 尺度下）
    score = clamp(piecewise(lap_var, [
        (3.0, 10.8),
        (89.6, 53.6),
        (187.9, 70.6),
        (214.9, 70.7),
        (225.1, 72.0),
        (359.5, 78.7),
        (665.8, 90.6),
    ]))
    return {
        'score': round(score, 1),
        'method': 'real',
        'method_label': '真实测量',
        'metrics': {
            'laplacian_variance': round(lap_var, 1),
            'gradient_mean': round(grad_mean, 2),
            'hf_energy_ratio_pct': round(hf_ratio, 3),
        },
        'notes': '拉普拉斯方差衡量高频细节能量，越大越清晰；与文件路径无关',
    }


# ==========================================================================
# 2. 曝光 exposure（real）
# ==========================================================================


def measure_exposure(r, g, b) -> Dict[str, Any]:
    """曝光 = 亮度分布是否落在可用区间。

    文档/界面截图特例（is_doc_background）：背景亮度是设计选择（白底/暗色
    主题都合法），纯白文字/纯黑文字同样是设计选择，削波在界面图上不构成缺陷
    → 亮度偏离与削波均豁免；对比度与动态范围仍按全图测（内容层次仍有效）。
    """
    gray = luma(r, g, b)
    mean_luma = float(gray.mean())
    clip_hi = pct(gray, 250.0, 256.0)
    clip_lo = pct(gray, 0.0, 6.0)
    contrast = float(gray.std())
    p1, p99 = np.percentile(gray, [1, 99])
    range_used = float(p99 - p1)

    (bg_frac, edge_frac, is_doc, bg_lo, bg_hi,
     is_ui, uniform_pct, top16_mass) = doc_signal(gray, (r, g, b))

    if is_doc:
        luma_score = 100.0
        clip_score = 100.0
        # 仍算出内容像素上的削波占比作指标展示（真实深色 UI 实测 19%~32%，
        # 那是白字不是过曝；白底 UI 同理是黑字）
        content = (gray < bg_lo) | (gray >= bg_hi)
        if content.any():
            cg = gray[content]
            clip_hi = pct(cg, 250.0, 256.0)
            clip_lo = pct(cg, 0.0, 6.0)
    else:
        luma_score = clamp(100 - abs(mean_luma - 120.0) * 0.55)
        clip_score = clamp(100 - clip_hi * 4.5 - clip_lo * 4.5)

    contrast_score = clamp(piecewise(contrast, [
        (5.0, 25.0), (20.0, 60.0), (45.0, 90.0), (70.0, 100.0), (95.0, 70.0),
    ]))
    range_score = clamp(piecewise(range_used, [
        (15.0, 20.0), (60.0, 60.0), (140.0, 90.0), (220.0, 100.0),
    ]))

    score = 0.30 * luma_score + 0.35 * clip_score + 0.20 * contrast_score + 0.15 * range_score
    return {
        'score': round(clamp(score), 1),
        'method': 'real',
        'method_label': '真实测量',
        'metrics': {
            'mean_luma': round(mean_luma, 1),
            'highlight_clip_pct': round(clip_hi, 2),
            'shadow_clip_pct': round(clip_lo, 2),
            'contrast_std': round(contrast, 1),
            'dynamic_range': round(range_used, 1),
            'bg_frac_pct': round(bg_frac, 1),
            'edge_frac_pct': round(edge_frac, 2),
            'is_doc_background': is_doc,
            'is_ui_rendered': is_ui,
            'uniform_pixel_pct': round(uniform_pct, 1),
            'top16_color_mass_pct': round(top16_mass, 1),
        },
        'notes': ('高光溢出/暗部死黑比例 + 平均亮度偏离中灰的程度 + 对比度与动态范围'
                  if not is_doc else
                  '界面/文档截图：亮度偏离与削波均豁免（背景与文字颜色都是设计选择）；对比度与动态范围照常'),
    }


# ==========================================================================
# 3. 色彩 color（defect，色偏旗标）
# ==========================================================================


def measure_color(r, g, b) -> Dict[str, Any]:
    """色彩 = 色偏缺陷检测。不偏色 = 100 分，超过保守阈值才罚。

    饱和度/色彩丰富度衡量的是风格而非质量（完美黑白照这两项≈0，会被误伤），
    因此不计分。

    界面/文档截图：配色由界面设计决定，灰世界假设与「单通道削波」在此都不成立
    （浅蓝面板的 B 通道天然 ≥250）→ 命中豁免则不判色偏；仅当白平衡偏离极端
    （> 25）时仍按常规处罚，防止真被夜灯/滤镜染黄的截图漏网。
    """
    mr, mg, mb = r.mean(), g.mean(), b.mean()
    wb_dev = (abs(mr - mg) + abs(mg - mb) + abs(mr - mb)) / 3.0

    # 单通道削波 = 偏色的直接证据；三通道同时削波 = 纯白过曝，归曝光维度
    r_clip = r >= 250.0
    g_clip = g >= 250.0
    b_clip = b >= 250.0
    single_clip = ((r_clip & ~g_clip & ~b_clip) |
                   (g_clip & ~r_clip & ~b_clip) |
                   (b_clip & ~r_clip & ~g_clip))
    channel_clip = float(np.count_nonzero(single_clip)) / max(r.size, 1) * 100.0

    gray = luma(r, g, b)
    (_bg_frac, _edge_frac, is_doc, _bg_lo, _bg_hi,
     _is_ui, _uniform_pct, _top16_mass) = doc_signal(gray, (r, g, b))
    ui_exempt = bool(is_doc and wb_dev <= UI_EXTREME_WB_DEV)

    cast_penalty = clamp((wb_dev - 8.0) * 4.0, 0.0, 60.0) if wb_dev > 8.0 else 0.0
    clip_penalty = clamp((channel_clip - 2.0) * 8.0, 0.0, 25.0) if channel_clip > 2.0 else 0.0
    if ui_exempt:
        cast_penalty = 0.0
        clip_penalty = 0.0

    score = 100.0 - cast_penalty - clip_penalty
    return {
        'score': round(clamp(score), 1),
        'method': 'defect',
        'method_label': '缺陷检测（色偏）',
        'metrics': {
            'whitebalance_deviation': round(wb_dev, 1),
            'max_channel_clip_pct': round(channel_clip, 2),
            'cast_penalty': round(cast_penalty, 1),
            'clip_penalty': round(clip_penalty, 1),
            'color_cast_detected': bool(cast_penalty > 0 or clip_penalty > 0),
            'is_doc_background': is_doc,
            'ui_color_exempted': ui_exempt,
        },
        'notes': ('界面/文档截图：配色由界面设计决定，不判色偏（白平衡偏离极端时仍报警）；'
                  '饱和度/色彩丰富度属风格非质量'
                  if ui_exempt else
                  '色偏旗标：白平衡偏离>8或单通道削波>2%才扣分（三通道同削=过曝归曝光维度）；'
                  '饱和度/色彩丰富度属风格非质量，不再计分'),
    }


# ==========================================================================
# 4. 画面损坏 damage（real）
# ==========================================================================


def measure_damage(r, g, b) -> Dict[str, Any]:
    """画面损坏 = 噪声 / 压缩块效应 / 椒盐噪点。

    块效应（JPEG 8x8）：块边界处的水平差分均值 / 块内差分均值。
    【V1.23.0 修正】col_diff[:, c] 是「第 c 列与第 c+1 列之间」的差分，
    8x8 块边界落在 c ≡ 7 (mod 8)（即 7, 15, 23...）。旧代码把边界列也算进
    「非边界」分母，比值被系统性拉向 1.0（块效应被低估）。现按公式意图：
    非边界 = 排除全部 c ≡ 7 (mod 8)。
    """
    gray = luma(r, g, b)

    # Immerkaer 快速噪声估计：σ ≈ sqrt(π/2)·mean|I ⊛ M|
    mask = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float64) / 6.0
    h, w = gray.shape
    if h > 2 and w > 2:
        pad = np.pad(gray, 1, mode='edge')
        conv = np.zeros_like(gray)
        for dy in range(3):
            for dx in range(3):
                conv += mask[dy, dx] * pad[dy:dy + h, dx:dx + w]
        noise_sigma = float(np.sqrt(math.pi / 2) * np.abs(conv).mean())
    else:
        noise_sigma = 0.0

    # JPEG 块效应：边界列 vs 非边界列
    block_ratio = 1.0
    if h > 16 and w > 16:
        col_diff = np.abs(np.diff(gray, axis=1))
        boundary_cols = np.arange(7, w - 1, 8)                 # c ≡ 7 (mod 8)
        inner_cols = np.array([c for c in range(w - 1) if (c % 8) != 7])  # 其余为块内
        if len(boundary_cols) and len(inner_cols):
            b_mean = col_diff[:, boundary_cols].mean()
            i_mean = col_diff[:, inner_cols].mean()
            block_ratio = float(b_mean / (i_mean + 1e-9))

    # 椒盐：与 3x3 中值差 > 40 的像素占比
    if h > 2 and w > 2:
        pad = np.pad(gray, 1, mode='edge')
        stack = np.stack([pad[dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3)])
        med = np.median(stack, axis=0)
        impulse_pct = float(np.count_nonzero(np.abs(gray - med) > 40)) / gray.size * 100.0
    else:
        impulse_pct = 0.0

    noise_score = clamp(piecewise(noise_sigma, [
        (0.3, 100.0), (1.0, 96.0), (2.0, 88.0), (4.0, 72.0), (8.0, 50.0),
        (18.0, 28.0), (40.0, 10.0),
    ]))
    block_score = clamp(piecewise(block_ratio, [
        (1.0, 100.0), (1.15, 85.0), (1.4, 60.0), (1.8, 35.0), (2.5, 15.0),
    ]))
    impulse_score = clamp(100 - impulse_pct * 8.0)

    score = 0.45 * noise_score + 0.30 * block_score + 0.25 * impulse_score
    return {
        'score': round(clamp(score), 1),
        'method': 'real',
        'method_label': '真实测量',
        'metrics': {
            'noise_sigma': round(noise_sigma, 2),
            'blockiness_ratio': round(block_ratio, 3),
            'impulse_noise_pct': round(impulse_pct, 3),
        },
        'notes': 'Immerkaer噪声估计 + JPEG块效应边界比 + 椒盐离群点比例',
    }


# ==========================================================================
# 5. 分辨率 resolution（real）
# ==========================================================================


def measure_resolution(r, g, b) -> Dict[str, Any]:
    """分辨率 = 像素规模 + 有效细节密度。"""
    h, w = r.shape
    long_edge = max(h, w)
    short_edge = min(h, w)
    megapixels = h * w / 1e6

    gray = luma(r, g, b)
    gray_s = gaussian_smooth(gray, GAUSSIAN_SIGMA)
    lap = laplacian(gray_s)
    detail_density = float(np.sum(lap ** 2)) / (float(np.sum(gray_s ** 2)) + 1e-9) * 100.0

    size_score = clamp(piecewise(long_edge, [
        (200.0, 25.0), (400.0, 50.0), (700.0, 75.0), (1200.0, 90.0), (2000.0, 100.0),
    ]))
    aspect = long_edge / max(short_edge, 1)
    aspect_penalty = max(0.0, (aspect - 3.0)) * 10.0

    score = 0.75 * size_score + 0.25 * clamp(piecewise(detail_density, [
        (0.05, 50.0), (0.30, 70.0), (0.80, 85.0), (1.80, 95.0), (3.70, 100.0),
    ])) - aspect_penalty
    return {
        'score': round(clamp(score), 1),
        'method': 'real',
        'method_label': '真实测量',
        'metrics': {
            'long_edge_px': int(long_edge),
            'short_edge_px': int(short_edge),
            'megapixels': round(megapixels, 2),
            'aspect_ratio': round(aspect, 2),
            'detail_density_pct': round(detail_density, 2),
        },
        'notes': '长边像素 + 有效细节密度（同尺寸下高频能量越实越高）',
    }


# ==========================================================================
# 6. 构图与留白 composition（heuristic）
# ==========================================================================


def largest_blank_component(mask: np.ndarray) -> float:
    """布尔空白掩码（块网格）的 8 邻域最大连通域占比。

    区分两种同样 40% 留白的版式：分散成页边距（健康）vs 聚成中心一大块
    （主体过小/拍歪/扫描没占满）。纯 Python 双遍扫描 + union-find。
    """
    bh, bw = mask.shape
    if bh == 0 or bw == 0:
        return 0.0
    labels = np.zeros((bh, bw), dtype=np.int32)
    parent = [0]

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    next_label = 1
    for i in range(bh):
        for j in range(bw):
            if not mask[i, j]:
                continue
            neigh = []
            if i > 0:
                if j > 0 and labels[i - 1, j - 1]:
                    neigh.append(int(labels[i - 1, j - 1]))
                if labels[i - 1, j]:
                    neigh.append(int(labels[i - 1, j]))
                if j + 1 < bw and labels[i - 1, j + 1]:
                    neigh.append(int(labels[i - 1, j + 1]))
            if j > 0 and labels[i, j - 1]:
                neigh.append(int(labels[i, j - 1]))
            if neigh:
                lbl = min(neigh)
                labels[i, j] = lbl
                for nb in neigh:
                    ra, rb = find(lbl), find(nb)
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
            else:
                labels[i, j] = next_label
                parent.append(next_label)
                next_label += 1

    sizes: Dict[int, int] = {}
    for i in range(bh):
        for j in range(bw):
            lbl = int(labels[i, j])
            if lbl:
                root = find(lbl)
                sizes[root] = sizes.get(root, 0) + 1
    largest = max(sizes.values()) if sizes else 0
    return largest / float(bh * bw) * 100.0


def measure_composition(r, g, b) -> Dict[str, Any]:
    """构图与留白 —— 启发式。

    空白掩码 = 块内标准差 < 6 【且】块内边缘密度（梯度>30 的像素占比）< 2%
    （双信号与：单一方差阈值会把浅色文字/细线条误判成空白）。

    文档/界面截图：留白是合理版式而非缺陷 → 豁免空白惩罚与空白封顶。
    真正白屏（翻车）几乎无边缘内容 → 不会被误豁免。

    【V1.23.0】is_doc 取自共享 doc_signal（全图口径），与 exposure / color /
    completeness 完全一致。
    """
    gray = luma(r, g, b)
    h, w = gray.shape

    bs = 16
    hh, ww = (h // bs) * bs, (w // bs) * bs
    blank_ratio = 0.0
    largest_cc_pct = 0.0
    edge_blank_pct = 0.0
    center_blank_pct = 0.0
    center_hole = False

    if hh >= bs and ww >= bs:
        crop = gray[:hh, :ww]
        bh, nbw = hh // bs, ww // bs

        blocks = crop.reshape(bh, bs, nbw, bs)
        block_std = blocks.std(axis=(1, 3))

        bx = np.abs(np.diff(crop, axis=1))
        by = np.abs(np.diff(crop, axis=0))
        grad = np.zeros_like(crop)
        grad[:, :-1] += bx
        grad[:-1, :] += by
        edge_blocks = (grad > 30.0).reshape(bh, bs, nbw, bs)
        edge_density = edge_blocks.mean(axis=(1, 3)) * 100.0

        blank = (block_std < 6.0) & (edge_density < 2.0)
        blank_ratio = float(np.count_nonzero(blank)) / blank.size * 100.0
        largest_cc_pct = largest_blank_component(blank)

        rows = np.array_split(np.arange(bh), 3)
        cols = np.array_split(np.arange(nbw), 3)
        cell_blank = np.zeros((3, 3))
        cell_total = np.zeros((3, 3))
        for i, ri in enumerate(rows):
            for j, cj in enumerate(cols):
                if len(ri) == 0 or len(cj) == 0:
                    continue
                sub = blank[np.ix_(ri, cj)]
                cell_blank[i, j] = np.count_nonzero(sub)
                cell_total[i, j] = sub.size
        border_mask = np.ones((3, 3), dtype=bool)
        border_mask[1, 1] = False
        border_blank = cell_blank[border_mask].sum()
        border_total = cell_total[border_mask].sum()
        edge_blank_pct = float(border_blank / border_total * 100.0) if border_total > 0 else 0.0
        center_blank_pct = (float(cell_blank[1, 1] / cell_total[1, 1] * 100.0)
                            if cell_total[1, 1] > 0 else 0.0)
        center_hole = bool(largest_cc_pct > 30.0 and center_blank_pct > 45.0
                           and center_blank_pct - edge_blank_pct > 10.0)

    # 文档/界面识别：共享全图口径
    (bg_frac, edge_frac, is_doc, _bg_lo, _bg_hi,
     is_ui, uniform_pct, top16_mass) = doc_signal(gray, (r, g, b))

    subject_ratio = 100.0 - blank_ratio

    # 三分法能量聚集：边缘能量按三分网格分箱，与均匀分布(1/9)的 KL 散度
    gx = np.abs(np.diff(gray, axis=1))[:-1, :]
    gy = np.abs(np.diff(gray, axis=0))[:, :-1]
    energy = gx + gy
    eh, ew = energy.shape
    kl = 0.0
    if eh >= 6 and ew >= 6:
        col_w = ew // 3
        row_h = eh // 3
        if col_w > 0 and row_h > 0:
            cell_sum = np.zeros((3, 3))
            for i in range(3):
                for j in range(3):
                    cell_sum[i, j] = energy[i * row_h:(i + 1) * row_h,
                                            j * col_w:(j + 1) * col_w].sum()
            total = cell_sum.sum() + 1e-9
            p = (cell_sum / total).ravel()
            kl = float(np.sum(p * np.log(p * 9 + 1e-12)))
    thirds_score = clamp(50 + kl * 45.0)

    if is_doc:
        blank_score = 100.0
    else:
        blank_score = clamp(piecewise(blank_ratio, [
            (0.0, 55.0), (5.0, 80.0), (20.0, 100.0), (45.0, 90.0), (75.0, 40.0), (95.0, 10.0),
        ]))
    subject_score = clamp(piecewise(subject_ratio, [
        (3.0, 20.0), (15.0, 55.0), (40.0, 90.0), (70.0, 100.0),
    ]))
    layout_penalty = (clamp((largest_cc_pct - 30.0) * 0.6, 0.0, 25.0)
                      if (center_hole and not is_doc) else 0.0)

    score = 0.45 * blank_score + 0.35 * subject_score + 0.20 * thirds_score - layout_penalty
    return {
        'score': round(clamp(score), 1),
        'method': 'heuristic',
        'method_label': '启发式（留白双信号可实测）',
        'metrics': {
            'blank_ratio_pct': round(blank_ratio, 1),
            'subject_ratio_pct': round(subject_ratio, 1),
            'thirds_energy_kl': round(kl, 3),
            'largest_blank_component_pct': round(largest_cc_pct, 1),
            'edge_blank_pct': round(edge_blank_pct, 1),
            'center_blank_pct': round(center_blank_pct, 1),
            'center_hole_detected': center_hole,
            'bg_frac_pct': round(bg_frac, 1),
            'edge_frac_pct': round(edge_frac, 2),
            'is_doc_background': is_doc,
            'is_ui_rendered': is_ui,
            'uniform_pixel_pct': round(uniform_pct, 1),
            'top16_color_mass_pct': round(top16_mass, 1),
        },
        'notes': '留白率=标准差+边缘密度双信号掩码；最大连通空白域与边缘/中心分布识别版式事故',
    }


# ==========================================================================
# 7. 内容完整性 completeness（proxy）
# ==========================================================================


def measure_completeness(r, g, b) -> Dict[str, Any]:
    """关键内容是否完整呈现 —— 本质是语义问题，只能用代理指标。

    代理指标能抓到：整帧发虚 / 大面积缺失 / 几乎无信息。
    抓不到：主体被裁掉、关键元素缺失（需视觉模型）。

    文档/界面截图特例：大片单一背景色是版式而不是「内容缺失」→
      1. 信息熵只在「内容像素」上算（背景把直方图压成一根针）；
      2. 覆盖率 = 「含内容像素的块占比」（而非 std>=6 的块占比）；
      3. 阈值按界面图像类重新标定。
    边缘覆盖率本身就是内容信号，仍按全图测。
    """
    gray = luma(r, g, b)
    h, w = gray.shape

    (bg_frac, edge_frac, is_doc, bg_lo, bg_hi,
     _is_ui, _uniform_pct, _top16_mass) = doc_signal(gray, (r, g, b))

    if is_doc:
        content_all = (gray < bg_lo) | (gray >= bg_hi)
        cg = gray[content_all]
        if cg.size == 0:
            cg = gray
    else:
        content_all = None
        cg = gray

    hist, _ = np.histogram(cg, bins=256, range=(0, 256))
    p = hist[hist > 0] / hist.sum()
    entropy = float(-np.sum(p * np.log2(p)))

    gx = np.abs(np.diff(gray, axis=1))
    gy = np.abs(np.diff(gray, axis=0))
    grad = np.zeros_like(gray)
    grad[:, :-1] += gx
    grad[:-1, :] += gy
    edge_pct = float(np.count_nonzero(grad > 20.0)) / gray.size * 100.0

    bs = 16
    hh, ww = (h // bs) * bs, (w // bs) * bs
    nonblank = 100.0
    if hh >= bs and ww >= bs:
        if is_doc:
            cb = content_all[:hh, :ww].reshape(hh // bs, bs, ww // bs, bs)
            nonblank = float(cb.any(axis=(1, 3)).mean()) * 100.0
        else:
            blocks = gray[:hh, :ww].reshape(hh // bs, bs, ww // bs, bs)
            block_std = blocks.std(axis=(1, 3))
            nonblank = float(np.count_nonzero(block_std >= 6.0)) / block_std.size * 100.0

    if is_doc:
        entropy_score = clamp(piecewise(entropy, [
            (2.5, 30.0), (3.5, 60.0), (4.5, 85.0), (5.5, 100.0),
        ]))
        coverage_score = clamp(piecewise(nonblank, [
            (5.0, 25.0), (15.0, 55.0), (30.0, 85.0), (50.0, 100.0),
        ]))
    else:
        entropy_score = clamp(piecewise(entropy, [
            (2.0, 20.0), (4.0, 50.0), (6.0, 80.0), (7.2, 100.0),
        ]))
        coverage_score = clamp(piecewise(nonblank, [
            (10.0, 30.0), (35.0, 65.0), (70.0, 95.0), (95.0, 100.0),
        ]))
    edge_score = clamp(piecewise(edge_pct, [
        (0.5, 25.0), (3.0, 60.0), (10.0, 90.0), (25.0, 100.0),
    ]))

    score = 0.35 * entropy_score + 0.35 * edge_score + 0.30 * coverage_score
    return {
        'score': round(clamp(score), 1),
        'method': 'proxy',
        'method_label': '代理指标（语义需视觉模型）',
        'metrics': {
            'entropy_bits': round(entropy, 2),
            'edge_coverage_pct': round(edge_pct, 1),
            'nonblank_ratio_pct': round(nonblank, 1),
            'bg_frac_pct': round(bg_frac, 1),
            'is_doc_background': is_doc,
        },
        'notes': ('信息熵+边缘覆盖率+非空白占比可实测；「关键内容是否缺失」需视觉模型'
                  if not is_doc else
                  '界面/文档截图：熵与覆盖率改在内容像素上统计（背景大片空白是版式），阈值按界面类标定'),
    }


# ==========================================================================
# 评分流水线
# ==========================================================================

MEASURERS = {
    'clarity': measure_clarity,
    'exposure': measure_exposure,
    'color': measure_color,
    'damage': measure_damage,
    'resolution': measure_resolution,
    'composition': measure_composition,
    'completeness': measure_completeness,
}


def analyze_image(image: Image.Image) -> Dict[str, Dict[str, Any]]:
    """对一张图计算全部 7 个维度的指标。

    单维度失败不拖垮整张图，兜底 70 分中性值并标记 method='error'。
    （注意：兜底会显式标记，线上系统在诊断里会显示「该维度计算异常」，
      不会被误当成正常分数 —— V1.18.1 交接文档的参考实现漏了这个标记。）
    """
    r, g, b = prepare(image)
    out: Dict[str, Dict[str, Any]] = {}
    for dim_key, fn in MEASURERS.items():
        try:
            out[dim_key] = fn(r, g, b)
        except Exception as exc:  # noqa: BLE001
            out[dim_key] = {
                'score': 70.0,
                'method': 'error',
                'method_label': '计算失败',
                'metrics': {'error': str(exc)},
                'notes': '该维度计算异常，已退回中性分（70）',
            }
    return out


def apply_curve(slope: float, intercept: float, x: float,
                x_min: Optional[float] = None,
                x_max: Optional[float] = None) -> float:
    """把一个维度的 Agent 分映射到人工视角的维度分。

    区间外（x < x_min）：y = x + dev_at_xmin × (x / x_min)
    区间外（x > x_max）：y = x + dev_at_xmax × ((100-x) / (100-x_max))
    偏差向 0 线性收敛 —— 分数越极端，Agent 判断越可靠，人工干预越小。
    """
    y = slope * x + intercept
    if x_min is not None and x < x_min:
        dev = slope * x_min + intercept - x_min
        y = x + dev * (x / x_min) if x_min > 0 else x
    elif x_max is not None and x > x_max:
        dev = slope * x_max + intercept - x_max
        y = x + dev * ((100.0 - x) / (100.0 - x_max)) if x_max < 100 else x
    return max(0.0, min(100.0, y))


def apply_curves(dimension_scores: Dict[str, float],
                 curves: Optional[Dict[str, Dict[str, float]]] = None
                 ) -> Tuple[Dict[str, float], Dict[str, Any]]:
    """对整组维度分套用校准曲线，返回 (映射后维度分, 明细)。

    没有曲线的维度走恒等映射（y=x），绝不能丢弃 —— 丢弃会漏掉加权项。
    """
    curves = curves if curves is not None else CURVES
    mapped: Dict[str, float] = {}
    detail: Dict[str, Any] = {}
    for dim, x in (dimension_scores or {}).items():
        c = (curves or {}).get(dim)
        if not c:
            mapped[dim] = x
            continue
        y = apply_curve(float(c['slope']), float(c['intercept']), float(x),
                        c.get('x_min'), c.get('x_max'))
        mapped[dim] = round(y, 1)
        detail[dim] = {'from': round(float(x), 1), 'to': round(y, 1),
                       'slope': c['slope'], 'intercept': c['intercept']}
    return mapped, detail


def score_image(path: str,
                curves: Optional[Dict[str, Dict[str, float]]] = None,
                offset: float = CALIBRATION_OFFSET) -> Dict[str, Any]:
    """对一张图片完整评分。

    流水线（四层，顺序不可交换）：
      像素 → ① 七维度各自算分(0~100)
           → ② 逐维度校准曲线映射（有则映射，无则恒等）
           → ③ 按权重加权求和（按总权重归一化）
           → ④ + 整体偏差补偿 offset，再套条件性 Cap 封顶
           → 最终分 + 告警状态

    curves=None 时使用本文件内置的 V1.23.0 生效曲线。
    """
    with Image.open(path) as img:
        analysis = analyze_image(img)
    # 所有分数强制转成 Python float，避免 numpy 标量（np.float64）混入，
    # 否则对方 json.dumps 序列化会直接报错。
    dims = {k: float(v['score']) for k, v in analysis.items()}

    # ② 校准曲线（无曲线的维度保持恒等，不可丢弃）
    cal, curve_detail = apply_curves(dims, curves)

    # ③ 加权（按总权重归一化，权重合计 97 不是 100）
    tw = sum(DIMENSIONS.values())
    weighted = sum(cal[k] / 100.0 * DIMENSIONS[k] for k in cal) / tw * 100.0

    # ④ offset + 条件性 Cap
    s = clamp(weighted + offset)
    triggered: List[str] = []
    if dims.get('completeness', 100) < 30:
        triggered.append('key_content_unrecognizable')
    clarity = dims.get('clarity', 100)
    if 30 <= clarity < 60:
        triggered.append('subject_blurrable')
    comp_metrics = analysis.get('composition', {}).get('metrics', {})
    br = comp_metrics.get('blank_ratio_pct')
    is_doc = comp_metrics.get('is_doc_background', False)
    if br is not None:
        if br > 80 and not is_doc:
            triggered.append('blank_or_tiny_subject')
    elif dims.get('composition', 100) < 40:
        triggered.append('blank_or_tiny_subject')
    if clarity < 30 or dims.get('damage', 100) < 30:
        triggered.append('detail_unacceptable')

    caps = [CAPS[name] for name in triggered if name in CAPS]
    final = min([s] + caps) if caps else s

    if final < ALERT_THRESHOLD:
        status = 'alert'
    elif final < GOOD_THRESHOLD:
        status = 'warning'
    else:
        status = 'good'

    return {
        'version': VERSION,
        'final_score': round(final, 1),
        'status': status,
        'dimension_scores': dims,
        'calibrated_dimension_scores': cal,
        'curve_detail': curve_detail,
        'raw_weighted_score': round(
            sum(dims[k] / 100.0 * DIMENSIONS[k] for k in dims) / tw * 100.0, 2),
        'weighted_score_before_cap': round(weighted, 2),
        'calibration_offset': round(offset, 2),
        'triggered_caps': triggered,
        'applied_cap': round(final, 1) if caps else None,
        'analysis': analysis,
    }


def _format_human(res: Dict[str, Any], path: str) -> str:
    """人话版输出：维度分 + 校准分 + 总分 + 低分原因。"""
    lines = []
    lines.append('=' * 64)
    lines.append('  %s' % os.path.basename(path))
    lines.append('=' * 64)
    order = ['clarity', 'resolution', 'composition', 'completeness',
             'color', 'damage', 'exposure']
    name_cn = {
        'clarity': '清晰度', 'resolution': '分辨率与噪点', 'composition': '构图与留白',
        'completeness': '内容完整性', 'color': '色彩', 'damage': '画面损坏',
        'exposure': '亮度与曝光',
    }
    lines.append('%-14s %8s %8s   %s' % ('维度', '原始分', '校准分', '说明'))
    lines.append('-' * 64)
    for dim in order:
        if dim not in res['dimension_scores']:
            continue
        raw = res['dimension_scores'][dim]
        cal = res['calibrated_dimension_scores'].get(dim, raw)
        detail = res['curve_detail'].get(dim)
        note = ''
        if detail:
            note = '经校准曲线映射 (slope=%.4f)' % detail['slope']
        elif dim in res['analysis']:
            note = res['analysis'][dim].get('notes', '')[:34]
        lines.append('%-14s %8.1f %8.1f   %s' % (name_cn[dim], raw, cal, note))
    lines.append('-' * 64)
    lines.append('加权总分（校准后）: %.2f' % res['weighted_score_before_cap'])
    lines.append('Cap 触发: %s' % (', '.join(res['triggered_caps']) or '无'))
    lines.append('最终得分: %.1f  [%s]' % (
        res['final_score'],
        {'alert': '不通过', 'warning': '警告', 'good': '良好'}[res['status']]))
    lines.append('')
    return '\n'.join(lines)


def main(argv: List[str]) -> int:
    args = list(argv[1:])
    as_json = False
    if '--json' in args:
        as_json = True
        args.remove('--json')
    if not args:
        print('用法: python reference_scoring.py [--json] <图片路径> [更多图片...]')
        return 2

    results = []
    for path in args:
        if not os.path.isfile(path):
            print('跳过（文件不存在）: %s' % path)
            continue
        res = score_image(path)
        res['image_path'] = path
        results.append(res)
        if not as_json:
            print(_format_human(res, path))

    if as_json:
        print(json.dumps(
            [{k: v for k, v in r.items() if k != 'analysis'} for r in results],
            ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
