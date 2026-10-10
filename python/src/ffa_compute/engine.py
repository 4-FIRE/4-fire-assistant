"""回测编排：一次运行 = full / IS / OOS 三段（Q6 护栏：同报两组指标）。

流程：数据（DataFrame）→ 三段切分 → 各自 AShareBacktest.run(**params) →
抽取指标 → 组装 metrics/series/trades → 由 cli 落盘为运行产物。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from .broker import AShareBacktest, make_commission

# 报告必含指标 + 扩展指标（对应 Q6「报告必含项」）
REQUIRED_METRICS = ("return_pct", "return_annual_pct", "max_drawdown_pct", "sharpe", "win_rate_pct", "n_trades")
EXTRA_METRICS = ("profit_factor", "calmar", "sortino", "sqn", "commissions", "buy_hold_return_pct")


@dataclass
class RunResult:
    metrics: dict = field(default_factory=dict)      # {"full": {...}, "is": {...}, "oos": {...}}
    series: dict = field(default_factory=dict)       # candles + indicators + 三段净值/回撤
    trades: list = field(default_factory=list)       # full 段成交明细
    rejections: dict = field(default_factory=dict)   # 每段 A股规则拒绝计数


def prepare_data(df: pd.DataFrame) -> pd.DataFrame:
    """统一列为 Open/High/Low/Close/Volume，DatetimeIndex 升序。"""
    rename = {c: c.capitalize() for c in df.columns if c.lower() in ("open", "high", "low", "close", "volume")}
    out = df.rename(columns=rename).copy()
    missing = {"Open", "High", "Low", "Close", "Volume"} - set(out.columns)
    if missing:
        raise ValueError(f"数据缺少列: {sorted(missing)}")
    out = out[["Open", "High", "Low", "Close", "Volume"]]
    if not isinstance(out.index, pd.DatetimeIndex):
        out.index = pd.to_datetime(out.index)
    return out.sort_index()


def split_is_oos(df: pd.DataFrame, is_ratio: float = 0.6) -> tuple[pd.DataFrame, pd.DataFrame]:
    """按 bar 数切分样本内(前60%)/样本外(后40%)。"""
    if not 0 < is_ratio < 1:
        raise ValueError("is_ratio 必须在 (0,1) 内")
    n = len(df)
    cut = max(1, int(n * is_ratio))
    return df.iloc[:cut], df.iloc[cut:]


def _extract_metrics(results: pd.Series) -> dict:
    def num(key: str) -> Optional[float]:
        v = results.get(key)
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if (math.isnan(f) or math.isinf(f)) else round(f, 4)

    out = {
        "return_pct": num("Return [%]"),
        "return_annual_pct": num("Return (Ann.) [%]"),
        "buy_hold_return_pct": num("Buy & Hold Return [%]"),
        "max_drawdown_pct": num("Max. Drawdown [%]"),
        "sharpe": num("Sharpe Ratio"),
        "win_rate_pct": num("Win Rate [%]"),
        "n_trades": num("# Trades"),
        "profit_factor": num("Profit Factor"),
        "calmar": num("Calmar Ratio"),
        "sortino": num("Sortino Ratio"),
        "sqn": num("SQN"),
        "commissions": num("Commissions [$]"),
        "equity_final": num("Equity Final [$]"),
    }
    return out


def _extract_series(results: pd.Series) -> dict:
    eq = results.get("_equity_curve")
    out = {"dates": [], "equity": [], "drawdown": []}
    if isinstance(eq, pd.DataFrame) and len(eq):
        out = {
            "dates": [str(d.date()) for d in eq.index],
            "equity": [round(float(v), 2) for v in eq["Equity"]],
            "drawdown": [round(float(v), 4) for v in eq["DrawdownPct"]],
        }
    return out


def _extract_trades(results: pd.Series) -> list[dict]:
    tr = results.get("_trades")
    if not isinstance(tr, pd.DataFrame) or not len(tr):
        return []
    data_index = results.get("_strategy").data.index  # type: ignore[union-attr]
    trades = []
    for _, row in tr.iterrows():
        entry_bar, exit_bar = int(row["EntryBar"]), int(row["ExitBar"])
        sl = row.get("SL")
        tp = row.get("TP")
        trades.append(
            {
                "side": "long" if row["Size"] > 0 else "short",
                "size": int(row["Size"]),
                "entry_time": str(data_index[entry_bar].date()) if entry_bar < len(data_index) else None,
                "exit_time": str(data_index[exit_bar].date()) if exit_bar < len(data_index) else None,
                "entry_price": round(float(row["EntryPrice"]), 4),
                "exit_price": round(float(row["ExitPrice"]), 4),
                "pnl": round(float(row["PnL"]), 2),
                "commission": round(float(row.get("Commission", 0.0)), 2),
                "return_pct": round(float(row["ReturnPct"]) * 100, 4),
                "sl": None if sl is None or (isinstance(sl, float) and math.isnan(sl)) else round(float(sl), 4),
                "tp": None if tp is None or (isinstance(tp, float) and math.isnan(tp)) else round(float(tp), 4),
            }
        )
    return trades


def _extract_indicators(results: pd.Series, plot_spec: dict, full_len: int) -> dict:
    """按策略 plot 声明抽取绘图指标序列（full 段）。"""
    strategy = results.get("_strategy")
    out: dict = {}
    if strategy is None:
        return out
    for section in ("overlay", "subcharts"):
        for entry in plot_spec.get(section) or []:
            key = entry.get("key")
            attr = getattr(strategy, key, None) if key else None
            if attr is None or not hasattr(attr, "__len__"):
                continue
            arr = np.asarray(attr, dtype=float)
            arr = arr[-full_len:] if arr.size >= full_len else arr
            out[key] = [None if (v != v) else round(float(v), 6) for v in arr.tolist()]
    return out


def _run_one(df: pd.DataFrame, strategy_cls, params: dict, *, cash: float, spread: float,
             fees: dict, allow_short: bool) -> tuple[pd.Series, list]:
    bt = AShareBacktest(
        prepare_data(df), strategy_cls,
        cash=cash, spread=spread,
        commission=make_commission(**fees), allow_short=allow_short,
    )
    results = bt.run(**params)
    rejections = getattr(bt, "_broker_instances", [])[-1].rejections if getattr(bt, "_broker_instances", []) else []
    return results, rejections


def _count_rejections(rejections: list) -> dict:
    counts = {"total": len(rejections), "t1": 0, "long_only": 0, "lot": 0}
    for _, reason in rejections:
        if "T+1" in reason:
            counts["t1"] += 1
        elif "开空" in reason:
            counts["long_only"] += 1
        elif "整手" in reason:
            counts["lot"] += 1
    return counts


def run_backtest(
    strategy_cls,
    data: pd.DataFrame,
    params: dict | None = None,
    *,
    cash: float = 1_000_000,
    spread: float = 0.001,
    fees: dict | None = None,
    allow_short: bool = False,
    is_ratio: float = 0.6,
    plot_spec: dict | None = None,
) -> RunResult:
    """跑 full/IS/OOS 三段，返回 RunResult（不落盘）。"""
    params = params or {}
    fees = fees or {}
    full = prepare_data(data)
    is_df, oos_df = split_is_oos(full, is_ratio)

    segments: dict[str, pd.DataFrame] = {"full": full, "is": is_df, "oos": oos_df}
    metrics: dict = {}
    series: dict = {}
    rejections: dict = {}
    trades: list = []
    full_results = None

    for name, seg in segments.items():
        results, rej = _run_one(
            seg, strategy_cls, params,
            cash=cash, spread=spread, fees=fees, allow_short=allow_short,
        )
        metrics[name] = _extract_metrics(results)
        series[name] = _extract_series(results)
        rejections[name] = _count_rejections(rej)
        if name == "full":
            full_results = results
            trades = _extract_trades(results)
            series["candles"] = {
                "dates": [str(d.date()) for d in full.index],
                "open": [round(float(v), 4) for v in full["Open"]],
                "high": [round(float(v), 4) for v in full["High"]],
                "low": [round(float(v), 4) for v in full["Low"]],
                "close": [round(float(v), 4) for v in full["Close"]],
                "volume": [round(float(v), 2) for v in full["Volume"]],
            }
            series["indicators"] = _extract_indicators(results, plot_spec or {}, len(full))
            closes = [float(c) for c in full["Close"]]
            if closes:
                first_close = closes[0]
                series["buy_hold"] = {
                    "dates": series["candles"]["dates"],
                    "equity": [round(cash * (c / first_close), 2) for c in closes],
                }

    # 样本不足提示
    for seg_name, seg in (("is", is_df), ("oos", oos_df)):
        if len(seg) < 60:
            metrics[seg_name]["note"] = f"样本仅 {len(seg)} 根K线，指标可能不可靠"

    return RunResult(metrics=metrics, series=series, trades=trades, rejections=rejections)
