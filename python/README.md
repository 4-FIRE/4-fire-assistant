# 共享计算后端

客户端用 ffa --setup-compute 创建版本固定的共享虚拟环境。所有工作区共用依赖，实验记录分别保存。需要 Linux 和支持 venv 的 Python 3.11 或更新版本。

运行使用普通 Python 子进程，不是沙箱。程序设置 120 秒超时及 16 MiB 输出上限，清空继承环境。它不提供文件系统、网络、内存或完整进程树隔离。仅依靠清空环境不能阻止策略读取本机文件。

默认支持 A 股单标的回测及 SMA、EMA、MACD、RSI、BOLL。输入协议见 resources/references/compute.md。后端不取行情、不读取交易配置、不导入交易 SDK。

算法测试：在测试环境安装 pytest==8.4.2，运行 PYTHONPATH=python/src python -m pytest -q python/tests。真实运行器测试使用 FFA_TEST_RUNTIME 指向包含 runtime.json 的受管环境，再运行 Node 的 tests/research.test.mjs。

## 来源与许可

broker.py、engine.py、indicators.py 的基本公式和相关固定数据测试复用用户提供的 backtest 项目。仅复制计算部分到本仓库；运行与测试不读取原项目、虚拟环境或服务配置。复用源未附独立许可证，不能据此推定允许对外再许可。

backtesting.py 0.6.6 使用 AGPL-3.0，完整来源与许可见 https://github.com/kernc/backtesting.py 。其他依赖版本固定于 requirements.lock；安装包携带各自许可元数据。当前仓库 private=true。对外发布前须核对自有复用代码的许可与依赖分发义务。

## 已知模型限制

T+1 采用订单过滤；同批买卖的部分数量存在数量过滤简化。无涨跌停和独立交易日历。费用为模拟假设。IS/OOS 分别初始化资金和指标暖机。模型结果不证明策略在实际市场有效。
