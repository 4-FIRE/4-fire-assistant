"""Real local integration checks for the locked third-party calculation libraries."""

import json
from pathlib import Path
import tempfile
import unittest

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import statsmodels.api as sm
import talib
from backtesting import Backtest, Strategy
from PIL import Image
from scipy import stats
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


class IndicatorStrategy(Strategy):
    def init(self):
        self.average = self.I(talib.SMA, self.data.Close, 3)

    def next(self):
        if len(self.data) == 4 and self.data.Close[-1] > self.average[-1]:
            self.buy(size=1)
        elif len(self.data) == 7:
            self.position.close()


class NativeLibrariesTest(unittest.TestCase):
    def test_statistics_and_sklearn_share_pandas_inputs(self):
        features = pd.DataFrame({"step": np.arange(1., 13.)})
        target = 2. + 3. * features["step"]
        train, test = features.iloc[:8], features.iloc[8:]
        trend = stats.linregress(train["step"], target.iloc[:8])
        self.assertAlmostEqual(trend.slope, 3.)
        self.assertAlmostEqual(trend.intercept, 2.)
        regression = sm.OLS(target.iloc[:8], sm.add_constant(train)).fit()
        np.testing.assert_allclose(regression.predict(sm.add_constant(test)), target.iloc[8:])
        pipeline = make_pipeline(StandardScaler(), LinearRegression())
        pipeline.fit(train, target.iloc[:8])
        np.testing.assert_allclose(pipeline.predict(test), target.iloc[8:])

    def test_pandas_excel_parquet_and_feather_round_trips(self):
        frame = pd.DataFrame({
            "time": pd.date_range("2025-01-01", periods=3),
            "close": [10.5, 11.25, np.nan], "volume": [100, 200, 300],
        })
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frame.to_excel(root / "prices.xlsx", index=False, engine="openpyxl")
            frame.to_parquet(root / "prices.parquet", index=False, engine="pyarrow")
            frame.to_feather(root / "prices.feather")
            pd.testing.assert_frame_equal(frame, pd.read_excel(root / "prices.xlsx", engine="openpyxl"))
            pd.testing.assert_frame_equal(frame, pd.read_parquet(root / "prices.parquet", engine="pyarrow"))
            pd.testing.assert_frame_equal(frame, pd.read_feather(root / "prices.feather"))

    def test_seaborn_renders_a_matplotlib_image_without_a_display(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prices.png"
            figure, axes = plt.subplots(figsize=(4, 3), dpi=100)
            try:
                sns.lineplot(x=[1, 2, 3], y=[10., 12., 11.], errorbar=None, ax=axes)
                figure.savefig(path)
                with Image.open(path) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.size, (400, 300))
                    image.load()
            finally:
                plt.close(figure)

    def test_talib_arrays_and_strict_json(self):
        close = pd.Series(np.arange(1., 41.))
        average = talib.SMA(close.to_numpy(dtype=np.float64), timeperiod=20)
        self.assertTrue(np.isnan(average[:19]).all())
        self.assertEqual(average[19], 10.5)
        self.assertEqual(average[-1], 30.5)
        encoded = json.dumps(
            {"sma20": [float(x) if np.isfinite(x) else None for x in average]},
            allow_nan=False,
        )
        self.assertEqual(json.loads(encoded)["sma20"][:19], [None] * 19)

    def test_native_backtesting_with_talib_and_explicit_costs(self):
        close = 20. + np.arange(40) * .5
        data = pd.DataFrame({
            "Open": close + .1, "High": close + 1.,
            "Low": close - 1., "Close": close, "Volume": 1000,
        }, index=pd.date_range("2025-01-01", periods=len(close)))
        results = Backtest(
            data, IndicatorStrategy, cash=1000, commission=.001,
            spread=0, trade_on_close=False, finalize_trades=True,
        ).run()
        trades = results["_trades"]
        self.assertEqual(len(trades), 1)
        trade = trades.iloc[0]
        self.assertEqual(trade.Size, 1)
        self.assertEqual(trade.EntryBar, 4)
        self.assertEqual(trade.ExitBar, 7)
        self.assertEqual(trade.EntryPrice, data.Open.iloc[4])
        self.assertEqual(trade.ExitPrice, data.Open.iloc[7])
        costs = (trade.EntryPrice + trade.ExitPrice) * .001
        self.assertAlmostEqual(trade.Commission, costs)
        self.assertAlmostEqual(results["Equity Final [$]"], 1000 + trade.ExitPrice - trade.EntryPrice - costs)


if __name__ == "__main__":
    unittest.main()
