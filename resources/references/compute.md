# 计算协议

先用 research_status 检查共享 Python 环境。用户用 ffa --setup-compute 安装固定依赖。普通 Python 可访问宿主文件和网络，不是沙箱。运行器不主动传入交易凭据。不要在策略中调用外部交易工具。

research_compute 接收 project、request、可选 strategy 源码及 evidenceRefs。project 用字母、数字、点、下划线或连字符，不能含路径分隔符。输入数据须来自已授权查询或用户提供的资料；evidenceRefs 引用实际回执，不伪造来源。所有输入、源码和结果按运行 ID 保存。

request 包含：

- version：1。
- operation：indicators 或 backtest。
- context：symbol、market、currency、adjustment、source、obtainedAt，均为非空字符串。回测的 market=CN-A、currency=CNY。
- bars：按日期严格升序的已完成日 K。每项为 date、open、high、low、close、volume。数值有限，价格为正，成交量非负。
- parameters：indicators 可设 period（默认 20）；MACD 固定 12/26/9，RSI 固定 14，BOLL 为两倍总体标准差。
- backtest 的 parameters 可设 cash、spread、is_ratio、fees、strategy。默认资金 1000000、价差 0.001、样本内比例 0.6。fees 可含 rate、min_commission、stamp_rate、transfer_rate。strategy 是策略类参数对象。

回测的源码定义 Strategy 类，继承 backtesting.Strategy，提供 init 和 next。可从 ffa_compute.indicators 导入指标。示例：

```python
from backtesting import Strategy as Base
from ffa_compute.indicators import sma

class Strategy(Base):
    def init(self):
        self.average = self.I(sma, self.data.Close, 20)

    def next(self):
        if self.data.Close[-1] > self.average[-1] and not self.position:
            self.buy(size=.9)
        elif self.data.Close[-1] < self.average[-1]:
            self.position.close()
```

默认引擎按下一根 K 线撮合，买入按 100 股整手，提供 T+1 订单过滤与多头限制。费用默认值是模拟假设，不代表当前券商收费标准。

限制：单标的，无涨跌停和独立交易日历模型。T+1 同批部分数量处理有已知简化。IS/OOS 分别从初始资金和指标暖机开始；不能把 OOS 反复用于调参。报告要包含 full、IS、OOS、买入持有基准、逐笔交易、拒绝计数、费用与数据口径。
