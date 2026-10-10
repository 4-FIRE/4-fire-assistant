# 共享 Python 与计算库

ffa --setup-compute 创建固定依赖的共享虚拟环境。需要 Linux 和 Python 3.11+。所有工作区共用依赖，实验记录分别保存在 .ffa/projects。

运行器执行普通 Python，不要求固定 indicators/backtest 协议。它保存源码、输入、证据、日志、状态和脚本生成的文件。调用方式见 [计算说明](../resources/references/compute.md)。

运行不是沙箱。120 秒超时、16 MiB 日志上限和进程组取消只控制运行，不隔离文件、网络或完整进程树。清空继承环境不能阻止脚本访问宿主文件。

## 可选计算库

ffa_compute.indicators 提供 SMA、EMA、MACD、RSI 与 BOLL。ffa_compute.engine 提供 A 股单标的、多头、日线回测。其他研究可以使用普通 Python 和共享环境中的其他库，不受这个回测模型限制。

回测库的资金、费用和切分缺省值只是模拟参数，不是投资规则。正式研究应显式提供并说明假设。

已知限制：T+1 的同批买卖有数量过滤简化；未建模涨跌停和独立交易日历；IS/OOS 分别初始化资金与指标暖机。结果不证明策略在实盘有效。

## 验证

Node 测试创建临时真实 Python 环境，检查普通计算、结果保存、取消和工作区分离，不下载依赖。

算法测试另需固定计算依赖与 pytest==8.4.2：

```bash
PYTHONPATH=python/src python -m pytest -q python/tests
```

## 来源与许可

broker.py、engine.py、indicators.py 的基本公式和相关固定数据测试复用用户提供的 backtest 项目。只复制计算部分；运行与测试不读取原项目、虚拟环境或服务配置。复用源未附独立许可证，不能据此推定允许对外再许可。

backtesting.py 0.6.6 使用 AGPL-3.0，来源与许可见 https://github.com/kernc/backtesting.py 。其他依赖版本见 requirements.lock。当前仓库 private=true；对外发布前须核对复用代码许可和依赖分发义务。
