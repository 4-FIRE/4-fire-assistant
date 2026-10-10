"""A股规则层测试：T+1、整手、long-only、费率（全部离线，用微型 K 线）。"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from backtesting import Strategy

from ffa_compute import engine
from ffa_compute.broker import AShareBacktest, cn_commission, make_commission

from .fixtures import make_ohlcv, tiny_ohlcv


class Buy250(Strategy):
    """绝对数量买入 250 股（应取整为 200）。"""

    def init(self):
        self.done = False

    def next(self):
        if not self.done:
            self.buy(size=250)
            self.done = True


class BuyAll(Strategy):
    """比例买入（应整手取整）。"""

    def init(self):
        self.done = False

    def next(self):
        if not self.done:
            self.buy()
            self.done = True


class SellFlat(Strategy):
    """空仓卖出（应被 long-only 拒绝）。"""

    def init(self):
        pass

    def next(self):
        if len(self.data) <= 2:
            self.sell(size=100)


def _run(strategy_cls, df, **kw):
    bt = AShareBacktest(engine.prepare_data(df), strategy_cls, **kw)
    results = bt.run()
    broker = bt._broker_instances[-1]
    return results, broker


def test_commission_schedule():
    # 买入 1000 股 @10：佣金 max(10000*0.00025, 5)=5 + 过户费 0.1 = 5.1
    assert cn_commission(1000, 10.0) == pytest.approx(5.1)
    # 卖出：再加印花税 10000*0.0005 = 5
    assert cn_commission(-1000, 10.0) == pytest.approx(10.1)
    # 大额：佣金按比例
    assert cn_commission(100000, 10.0) == pytest.approx(100000 * 10 * 0.00025 + 100000 * 10 * 0.00001)


def test_lot_rounding_absolute_size():
    df = make_ohlcv(60, seed=1)
    results, broker = _run(Buy250, df)
    trades = results["_trades"]
    assert len(trades) == 1
    assert trades.iloc[0]["Size"] == 200  # 250 → 200


def test_lot_rounding_proportional():
    df = make_ohlcv(60, seed=1)
    results, broker = _run(BuyAll, df, cash=1_000_000)
    trades = results["_trades"]
    assert len(trades) == 1
    assert trades.iloc[0]["Size"] % 100 == 0
    assert trades.iloc[0]["Size"] > 0


@pytest.mark.parametrize("cash,price", [(1_000_000, 1.0), (10_000, 10.0), (1_010, 10.0)])
def test_proportional_market_buy_budgets_the_total_minimum_fee(cash, price):
    dates = pd.bdate_range("2024-01-02", periods=30)
    df = pd.DataFrame({key: price for key in ["open", "high", "low", "close"]}, index=dates)
    df["volume"] = 1_000_000
    commission = make_commission(rate=0.00025, min_commission=5, stamp_rate=0, transfer_rate=0)
    results, broker = _run(BuyAll, df, cash=cash, spread=0, commission=commission)
    quantity = int(results["_trades"].iloc[0]["Size"])
    assert quantity * price + commission(quantity, price) <= cash
    assert (quantity + 100) * price + commission(quantity + 100, price) > cash
    if cash == 1_000_000:
        assert quantity * price > 0.99 * cash


def test_proportional_market_buy_sizes_at_execution_open():
    dates = pd.bdate_range("2024-01-02", periods=30)
    df = pd.DataFrame({key: 1.0 for key in ["open", "high", "low", "close"]}, index=dates)
    df.loc[dates[2]:, ["open", "high", "low", "close"]] = 2.0
    df["volume"] = 1_000_000
    commission = make_commission(rate=0.00025, min_commission=5, stamp_rate=0, transfer_rate=0)
    results, broker = _run(BuyAll, df, cash=1_000_000, spread=0.001, commission=commission)
    trade = results["_trades"].iloc[0]
    assert trade["EntryBar"] == 2
    assert trade["EntryPrice"] == pytest.approx(2.002)
    assert trade["Size"] * trade["EntryPrice"] > 990_000
    assert trade["Size"] * trade["EntryPrice"] + commission(trade["Size"], trade["EntryPrice"]) <= 1_000_000


def test_long_only_rejects_short():
    df = make_ohlcv(60, seed=1)
    results, broker = _run(SellFlat, df)
    reasons = [r for _, r in broker.rejections]
    assert any("开空" in r for r in reasons)
    assert len(results["_trades"]) == 0  # 未成交


def test_allow_short_flag():
    df = make_ohlcv(60, seed=1)
    results, broker = _run(SellFlat, df, allow_short=True)
    assert len(results["_trades"]) >= 1
    assert results["_trades"].iloc[0]["Size"] < 0


def _sl_data() -> pd.DataFrame:
    """bar1 收盘 10 → 止损 9.8；bar2 最低 9.5 触发止损（与买入同日）。"""
    close = np.array([10.0, 10.0, 10.1, 10.2, 10.3, 10.4, 10.3, 10.2, 10.1, 10.2, 10.3, 10.4])
    open_ = np.concatenate([[10.0], close[:-1]])
    high = np.maximum(open_, close) * 1.01
    low = np.array([9.9, 9.9, 9.5, 9.8, 9.9, 10.0, 9.9, 9.8, 9.7, 9.8, 9.9, 10.0])
    volume = np.full(12, 1_000_000.0)
    dates = pd.bdate_range(start="2024-01-02", periods=12)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=dates,
    )


class BuyWithSL(Strategy):
    """bar1 买入并挂 2% 止损，bar2 触发 → 应被 T+1 拦截（当日买入不可卖出）。"""

    def init(self):
        self.done = False

    def next(self):
        if not self.done:
            self.buy(size=1000, sl=self.data.Close[-1] * 0.98)
            self.done = True


def test_t1_blocks_same_bar_stop_loss():
    df = _sl_data()
    results, broker = _run(BuyWithSL, df)
    reasons = [r for _, r in broker.rejections]
    assert any("T+1" in r for r in reasons)
    # 止损未在同日（bar2）平仓：成交明细里唯一一笔的出场应在末尾（finalize）
    trades = results["_trades"]
    assert len(trades) == 1
    assert trades.iloc[0]["ExitBar"] == len(df) - 1


def test_engine_reports_t1_rejections():
    df = _sl_data()
    result = engine.run_backtest(BuyWithSL, df, plot_spec={})
    assert result.rejections["full"]["t1"] >= 1
    assert result.metrics["full"]["n_trades"] == 1
