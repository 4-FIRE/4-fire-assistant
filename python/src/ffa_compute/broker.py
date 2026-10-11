"""A股 Broker 适配层：T+1、100 股整手（买入）、单边印花税 + 佣金 + 过户费、默认多头。

实现方式：子类化 backtesting 0.6.6 的私有 `_Broker`，在 `_process_orders` 前置钩子
执行规则过滤，在 `_open_trade` 对比例化买入做整手取整。与 backtesting==0.6.6 内部
API 耦合，版本已锁（见 pyproject.toml）。

已知简化：
- T+1 为订单级拦截：同批 buy+sell 且已有旧仓时，若卖出量超过旧仓可能部分穿透；
  空仓同批买卖会被 long-only 拦截兜底。
- 未建模涨跌停和独立交易日历，交易日来自输入数据。
- 卖出允许零股（A股规则：卖出可非整手）；买入按 100 股向下取整。
"""

from __future__ import annotations

import warnings
from functools import partial
from typing import Callable, Optional

from backtesting import Backtest
from backtesting.backtesting import _Broker

# A股费率默认值（2023-08-28 印花税减半后）
DEFAULT_COMMISSION_RATE = 0.00025  # 佣金万2.5
DEFAULT_MIN_COMMISSION = 5.0       # 单笔最低 5 元
DEFAULT_STAMP_RATE = 0.0005        # 印花税 0.05%，仅卖出
DEFAULT_TRANSFER_RATE = 0.00001    # 过户费万0.1，双边


def cn_commission(
    order_size: float,
    price: float,
    *,
    rate: float = DEFAULT_COMMISSION_RATE,
    min_commission: float = DEFAULT_MIN_COMMISSION,
    stamp_rate: float = DEFAULT_STAMP_RATE,
    transfer_rate: float = DEFAULT_TRANSFER_RATE,
) -> float:
    """交易费用（与输入价格同币种）：佣金(max(万2.5, 5元)) + 过户费 + 卖出印花税。"""
    value = abs(order_size) * price
    fee = max(value * rate, min_commission) + value * transfer_rate
    if order_size < 0:  # 卖出才收印花税
        fee += value * stamp_rate
    return fee


def make_commission(**fees) -> Callable[[float, float], float]:
    """构造带费率参数的 commission 可调用。"""
    def _commission(order_size: float, price: float) -> float:
        return cn_commission(order_size, price, **fees)
    return _commission


class AShareBroker(_Broker):
    """A股规则 Broker：T+1、整手买入、long-only（默认）。"""

    def __init__(
        self,
        *,
        data,
        cash: float,
        spread: float,
        commission,
        margin: float,
        trade_on_close: bool,
        hedging: bool,
        exclusive_orders: bool,
        index,
        allow_short: bool = False,
    ):
        super().__init__(
            data=data, cash=cash, spread=spread, commission=commission,
            margin=margin, trade_on_close=trade_on_close, hedging=hedging,
            exclusive_orders=exclusive_orders, index=index,
        )
        self._allow_short = allow_short
        self.rejections: list = []  # [(bar_index, reason), ...] 供指标统计

    def _reject(self, order, reason: str) -> None:
        self.rejections.append((self._i, reason))
        warnings.warn(f"time={self._i}: A股规则拒绝订单 [{reason}]: {order}", UserWarning)
        order.cancel()

    def _process_orders(self) -> None:
        i = self._i
        same_bar_long = any(t.size > 0 and t.entry_bar == i for t in self.trades)
        has_long = any(t.size > 0 for t in self.trades)

        for order in list(self.orders):
            # 1) T+1：当日买入的持仓当日不可卖出（含其 SL/TP 同日触发）
            if order.size < 0:
                parent = order.parent_trade
                if parent is not None:
                    if parent.entry_bar == i:
                        self._reject(order, "T+1：当日买入不可卖出（SL/TP 同日触发）")
                        continue
                elif same_bar_long:
                    self._reject(order, "T+1：当日买入不可卖出")
                    continue
            # 2) long-only：无多头持仓时的卖出 = 开空，默认拒绝
            if (
                order.size < 0
                and order.parent_trade is None
                and not has_long
                and not self._allow_short
            ):
                self._reject(order, "long-only：拒绝开空")
                continue
            # 3) 整手：绝对数量的买入向下取整到 100 股
            # 比例市价买入先按整笔费用求数量。内核把比例数量传给佣金
            # 函数时，最低佣金会被错误地折成单股费用，造成严重少买。
            if (len(self.orders) == 1 and 0 < order.size < 1 and order.parent_trade is None
                    and order.limit is None and order.stop is None):
                price = float(self._data.Open[-1])
                adjusted = self._adjusted_price(order.size, price)
                budget = self.margin_available * self._leverage * order.size
                lower, upper = 0, int(budget // adjusted // 100)
                while lower < upper:
                    middle = (lower + upper + 1) // 2
                    quantity = middle * 100
                    # 开仓收费使用含价差价格；取较大价格也覆盖内核的预算检查。
                    cost = quantity * adjusted + self._commission(quantity, max(price, adjusted))
                    if cost <= budget:
                        lower = middle
                    else:
                        upper = middle - 1
                if not lower:
                    self._reject(order, "整手：比例买入不足 100 股")
                    continue
                order._replace(size=lower * 100)
            if order.size > 0 and abs(order.size) >= 1:
                rounded = int(order.size // 100) * 100
                if rounded == 0:
                    self._reject(order, "整手：买入不足 100 股")
                    continue
                order._replace(size=rounded)

        super()._process_orders()

    def _open_trade(self, adjusted_price, size, sl, tp, time_index, tag):
        # 比例化买入（|size| < 1）在此解析为股数后取整到 100
        if size > 0:
            size = int(size // 100) * 100
            if size == 0:
                self.rejections.append((self._i, "整手：比例买入不足 100 股"))
                return
        super()._open_trade(adjusted_price, size, sl, tp, time_index, tag)


class AShareBacktest(Backtest):
    """使用 AShareBroker 的 Backtest，其余参数同 backtesting.Backtest。"""

    def __init__(
        self,
        data,
        strategy,
        *,
        cash: float = 1_000_000,
        spread: float = 0.001,
        commission: Optional[Callable[[float, float], float]] = None,
        allow_short: bool = False,
        **kwargs,
    ):
        commission = commission or make_commission()
        super().__init__(
            data, strategy,
            cash=cash, spread=spread, commission=commission,
            margin=1.0, trade_on_close=False, hedging=False,
            exclusive_orders=False, finalize_trades=True,
            **kwargs,
        )
        self._broker_instances: list = []

        def _make(**kw):
            broker = AShareBroker(**kw)
            self._broker_instances.append(broker)
            return broker

        self._broker = partial(
            _make, cash=cash, spread=spread, commission=commission,
            margin=1.0, trade_on_close=False, hedging=False,
            exclusive_orders=False, index=data.index, allow_short=allow_short,
        )
