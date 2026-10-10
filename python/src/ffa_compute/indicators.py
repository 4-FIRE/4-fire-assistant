"""内置指标库：供策略和行情研究调用的确定性计算。

公式约定：
- EMA: pandas ewm(span=n, adjust=False) 标准指数移动平均
- MACD: DIF=EMA12-EMA26, DEA=EMA(DIF,9), 柱=(DIF-DEA)*2
- RSI: Wilder 平滑（ewm(alpha=1/n, adjust=False)）
- BOLL: 中轨=SMA(n)，上下轨=中轨±2*标准差(n, ddof=0)

所有函数输入 pandas Series / numpy 数组，输出与输入等长的 numpy 数组，
前导不足窗口处为 NaN，与 backtesting.py self.I() 的向量化要求兼容。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _as_series(x) -> pd.Series:
    if isinstance(x, pd.Series):
        return x.astype(float)
    return pd.Series(np.asarray(x, dtype=float))


def sma(x, n: int) -> np.ndarray:
    """简单移动平均（前 n-1 个值为 NaN）。"""
    return _as_series(x).rolling(n).mean().to_numpy()


def ema(x, n: int) -> np.ndarray:
    """指数移动平均 ewm(span=n, adjust=False)。"""
    return _as_series(x).ewm(span=n, adjust=False).mean().to_numpy()


def macd(x, fast: int = 12, slow: int = 26, signal: int = 9):
    """MACD：返回 (dif, dea, hist)，hist=(dif-dea)*2。"""
    s = _as_series(x)
    dif = s.ewm(span=fast, adjust=False).mean() - s.ewm(span=slow, adjust=False).mean()
    dea = dif.ewm(span=signal, adjust=False).mean()
    hist = (dif - dea) * 2
    return dif.to_numpy(), dea.to_numpy(), hist.to_numpy()


def rsi(x, n: int = 14) -> np.ndarray:
    """RSI：Wilder 平滑，超买>70 / 超卖<30。"""
    s = _as_series(x)
    delta = s.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    out = out.fillna(100.0)  # avg_loss==0（持续上涨）时 RSI=100
    both_zero = (avg_gain == 0) & (avg_loss == 0)
    out[both_zero] = 50.0  # 持平段（涨跌皆零）取中性 50
    out[delta.isna()] = np.nan  # 首根无前值，RSI 未定义
    return out.to_numpy()


def boll(x, n: int = 20, k: float = 2.0):
    """布林带：返回 (mid, upper, lower)，std 用 ddof=0。"""
    s = _as_series(x)
    mid = s.rolling(n).mean()
    std = s.rolling(n).std(ddof=0)
    upper = mid + k * std
    lower = mid - k * std
    return mid.to_numpy(), upper.to_numpy(), lower.to_numpy()
