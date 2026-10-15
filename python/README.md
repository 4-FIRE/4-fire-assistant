# 可选 Python 计算库

需要 Linux 和 Python 3.11+。使用标准 Python 或 uv 工具准备共享环境，通过 `/ffa python /绝对路径/bin/python` 确认解释器。ffa 不在启动时自动安装依赖。

`ffa_python` 执行普通源码，保存输入、输出与产物；项目、长期事务和临时运行分别存放。参数与限制见[计算说明](../resources/references/compute.md)。它不是沙箱，也不提供交易权限。

计算库随 ffa 插件同版本发布，当前为 `0.3.0`。发布时将 `src/ffa_compute/__init__.py` 的 `__version__` 与根 `package.json` 同步；`pyproject.toml` 从该属性读取打包版本，不另设版本号。插件打包冒烟测试核对实际导入的计算库版本。

## 算法范围

ffa_compute.indicators 提供 SMA、EMA、MACD、RSI 与 BOLL。ffa_compute.engine 提供 A 股单标的、多头、日线回测。其他研究不受此模型限制。

费用与资金缺省值只是实验参数，不是投资规则。正式研究应显式说明假设。已知限制包括同批 T+1 数量过滤简化、未建模涨跌停与独立交易日历、IS/OOS 分开初始化资金和暖机。

算法测试需要 requirements.lock 中的依赖以及 pytest。运行 `PYTHONPATH=python/src python -m pytest -q python/tests`。Node 测试不下载 Python 依赖。

## 来源与许可

broker.py、engine.py、indicators.py 的基本公式及相关固定数据测试复用用户提供的 backtest 项目。运行与测试不读取原项目或个人环境。复用源未附独立许可证，不能推定允许对外再许可。

backtesting.py 0.6.6 使用 AGPL-3.0，见 https://github.com/kernc/backtesting.py 。其他版本见 requirements.lock。本包保留 private=true；对外发布前须核对复用代码许可与依赖分发义务。
