"""One request per process. Strategies run in the shared Python environment."""
from datetime import date
import contextlib
import importlib.util
import json
import math
from pathlib import Path
import sys

import numpy as np
import pandas as pd

from . import __version__, indicators
from .engine import run_backtest


def finite(value):
    if isinstance(value, dict):
        return {str(k): finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [finite(v) for v in value]
    if isinstance(value, (float, np.floating)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def run(request):
    if request.get("version") != 1 or request.get("operation") not in ("indicators", "backtest"):
        raise ValueError("Unsupported compute protocol")
    rows = request["bars"]
    if not isinstance(rows, list) or not 4 <= len(rows) <= 100000:
        raise ValueError("Expected 4..100000 completed OHLCV bars")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("date"), str) or len(row["date"]) != 10:
            raise ValueError("Expected daily YYYY-MM-DD dates")
        date.fromisoformat(row["date"])
        if not isinstance(row, dict) or any(not isinstance(row.get(k), (int, float)) or
                isinstance(row.get(k), bool) or not math.isfinite(row[k]) for k in ("open", "high", "low", "close", "volume")):
            raise ValueError("Missing or non-finite OHLCV")
        if min(row[k] for k in ("open", "high", "low", "close")) <= 0 or row["volume"] < 0:
            raise ValueError("Invalid price or volume")
        if row["low"] > min(row["open"], row["close"]) or row["high"] < max(row["open"], row["close"]) or row["low"] > row["high"]:
            raise ValueError("Inconsistent OHLC")
    data = pd.DataFrame(rows)
    data.index = pd.DatetimeIndex(pd.to_datetime(data.pop("date"), errors="raise", utc=True)).tz_convert(None)
    if data.index.has_duplicates or not data.index.is_monotonic_increasing:
        raise ValueError("Bars must have unique increasing dates")
    if not all(isinstance(request.get("context", {}).get(k), str) and request["context"][k].strip() for k in ("symbol", "market", "currency", "adjustment", "source", "obtainedAt")):
        raise ValueError("Explicit symbol, market, currency, adjustment, source and obtainedAt are required")
    options = request.get("parameters", {})
    if request["operation"] == "indicators":
        period = options.get("period", 20)
        if not isinstance(period, int) or not 2 <= period <= 1000:
            raise ValueError("period must be 2..1000")
        close = data["close"]
        dif, dea, hist = indicators.macd(close)
        mid, upper, lower = indicators.boll(close, period)
        return {"series": finite({"dates": [d.isoformat() for d in data.index],
                "sma": indicators.sma(close, period), "ema": indicators.ema(close, period),
                "macd": {"dif": dif, "dea": dea, "hist": hist},
                "rsi": indicators.rsi(close), "boll": {"mid": mid, "upper": upper, "lower": lower}}),
                "definitions": {"period": period, "macd": [12, 26, 9], "rsi": 14, "bollDeviation": 2, "bollDDoF": 0}}
    if request["context"]["market"] != "CN-A" or request["context"]["currency"] != "CNY":
        raise ValueError("Default backtest supports CN-A / CNY only")
    allowed = {"cash", "spread", "fees", "is_ratio", "strategy"}
    if set(options) - allowed:
        raise ValueError("Unsupported backtest parameter")
    cash, spread, ratio = options.get("cash", 1000000), options.get("spread", .001), options.get("is_ratio", .6)
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (cash, spread, ratio)):
        raise ValueError("Cash, spread and split must be numbers")
    if not math.isfinite(cash) or cash <= 0 or not 0 <= spread < 1 or not 0 < ratio < 1:
        raise ValueError("Invalid cash, spread or split")
    if min(int(len(data) * ratio), len(data) - int(len(data) * ratio)) < 3:
        raise ValueError("Each split needs at least three bars")
    fees = options.get("fees", {})
    if set(fees) - {"rate", "min_commission", "stamp_rate", "transfer_rate"} or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or v < 0 for v in fees.values()):
        raise ValueError("Invalid fees")
    # The host writes this exact source into the input snapshot.
    path = Path(sys.argv[1]).parent / "strategy.py"
    spec = importlib.util.spec_from_file_location("research_strategy", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = run_backtest(module.Strategy, data, params=options.get("strategy", {}),
                          cash=cash, spread=spread, fees=fees, is_ratio=ratio)
    return {"metrics": finite(result.metrics), "series": finite(result.series),
            "trades": finite(result.trades), "rejections": finite(result.rejections),
            "warnings": ["Single symbol, long only; no price limits or trading calendar model.",
                         "T+1 order filtering has a known same-batch partial-quantity limitation.",
                         "IS and OOS start with separate cash and indicator warm-up.",
                         "Default fees are simulation assumptions; verify them for the research date."]}


def main():
    try:
        request = json.loads(Path(sys.argv[1]).read_text())
        with contextlib.redirect_stdout(sys.stderr):
            value = run(request)
        result = {"version": 1, "backend": __version__, "status": "ok", **value}
    except Exception as error:
        result = {"version": 1, "backend": __version__, "status": "error",
                  "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
