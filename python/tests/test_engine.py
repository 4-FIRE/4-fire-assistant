import numpy as np
import pytest
from backtesting import Strategy
from ffa_compute import engine, indicators
from .fixtures import make_ohlcv, tiny_ohlcv

class Cross(Strategy):
    def init(self):
        self.fast = self.I(indicators.sma, self.data.Close, 5)
        self.slow = self.I(indicators.sma, self.data.Close, 20)
    def next(self):
        if self.fast[-1] > self.slow[-1] and not self.position:
            self.buy(size=.9)
        elif self.fast[-1] < self.slow[-1]:
            self.position.close()

def test_full_is_oos_and_benchmark():
    data = make_ohlcv(250)
    result = engine.run_backtest(Cross, data)
    assert set(result.metrics) == {"full", "is", "oos"}
    assert len(result.series["full"]["equity"]) == 250
    assert len(result.series["is"]["equity"]) == 150
    assert len(result.series["oos"]["equity"]) == 100
    assert result.series["buy_hold"]["equity"][0] == 1000000
    assert result.trades
    assert all(t["size"] % 100 == 0 and t["commission"] > 0 for t in result.trades)
    for metrics in result.metrics.values():
        assert all(key in metrics for key in engine.REQUIRED_METRICS)

def test_next_open_and_fees():
    class Once(Strategy):
        def init(self): pass
        def next(self):
            if len(self.data) == 2: self.buy(size=100)
            if len(self.data) == 5: self.position.close()
    data = tiny_ohlcv()
    result = engine.run_backtest(Once, data, spread=0)
    trade = result.trades[0]
    assert trade["entry_price"] == pytest.approx(data.iloc[2].open)
    assert trade["exit_price"] == pytest.approx(data.iloc[5].open)
    assert trade["commission"] > 10
    assert trade["return_pct"] == pytest.approx(trade["pnl"] / (trade["size"] * trade["entry_price"]) * 100, abs=.0001)

def test_indicators_known_values_and_warmup():
    prices = np.arange(1., 31.)
    assert np.isnan(indicators.sma(prices, 5)[3])
    assert indicators.sma(prices, 5)[4] == 3
    assert indicators.ema(prices, 3)[1] == 1.5
    assert indicators.rsi(np.ones(10))[1] == 50
    assert indicators.rsi(prices)[-1] == 100
    mid, high, low = indicators.boll(prices, 5)
    assert high[-1] == pytest.approx(mid[-1] + 2 * np.std(prices[-5:]))
    assert low[-1] < mid[-1]
    dif, dea, hist = indicators.macd(prices)
    assert hist[-1] == pytest.approx(2 * (dif[-1] - dea[-1]))
