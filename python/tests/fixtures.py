"""测试夹具：确定性数据，不依赖服务或网络。"""

from __future__ import annotations

import numpy as np
import pandas as pd


def make_ohlcv(n: int = 250, seed: int = 7, start: str = "2024-01-02") -> pd.DataFrame:
    """固定种子随机游走 OHLCV，返回 DataFrame(index=DatetimeIndex, columns=[open,high,low,close,volume])。"""
    rng = np.random.RandomState(seed)
    close = 10.0 + np.cumsum(rng.normal(0.05, 0.5, n))
    close = np.maximum(close, 1.0)
    open_ = close * (1 + rng.normal(0, 0.002, n))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.004, n)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.004, n)))
    volume = rng.randint(100_000, 1_000_000, n).astype(float)
    dates = pd.bdate_range(start=start, periods=n)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=dates,
    )


def tiny_close() -> np.ndarray:
    """手写小序列：1..10，用于指标公式的人工校验。"""
    return np.arange(1.0, 11.0)


def tiny_ohlcv() -> pd.DataFrame:
    """手写 12 根 K 线，价格 10 起步缓涨，便于人工核对成交/指标。"""
    close = np.array([10.0, 10.1, 10.2, 10.3, 10.4, 10.5, 10.4, 10.3, 10.2, 10.3, 10.4, 10.5])
    open_ = np.concatenate([[10.0], close[:-1]])
    high = np.maximum(open_, close) * 1.01
    low = np.minimum(open_, close) * 0.99
    volume = np.full(12, 1_000_000.0)
    dates = pd.bdate_range(start="2024-01-02", periods=12)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=dates,
    )
