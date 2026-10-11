# 普通 Python 研究

用 research_status 查看共享环境；用户可用 ffa --setup-compute 安装固定依赖。Python 3.11+ 环境由客户端管理，跨工作区共用，实验记录独立保存。

python 接收可选 owner，以及 code、inputs 和 evidenceRefs，不要求固定 indicators/backtest 协议。owner 为 projects/名称 或 areas/名称，运行保存在其 runs 子目录；省略 owner 时保存在 scratch/runs，不要求创建项目。每次运行的目录包含 main.py、inputs.json、evidence.json、manifest.json、stdout.txt 和 stderr.txt。脚本从当前目录读取 inputs.json，可以自行保存结果文件。

research_list 返回所有归属下的运行，含相对路径；可用 owner 限定项目、长期事务或 scratch。旧运行记录仍为 starting/running、但不属于当前运行器时，显示 interrupted 并保留 recordedState；原文件不被改写。中断后先查 manifest、日志和结果，不假设脚本未产生副作用。每次重算创建新运行，不恢复进程内存。

共享库包括 NumPy、pandas、SciPy、scikit-learn、statsmodels、matplotlib、backtesting 与 yfinance。选择适合任务的方法，不要求全部使用。使用 yfinance 等网络来源仍须核实数据来源、权限与限制。

ffa_compute.indicators 提供 SMA、EMA、MACD、RSI 和 BOLL。ffa_compute.engine.run_backtest 是可选的 A 股单标的、多头、日线计算库，不是助手能力边界。它支持 T+1、整手买入与停牌检查；尚未实现涨跌停和独立交易日历。其费用、资金及样本切分缺省值只是库的模拟参数，正式研究应显式提供并说明假设。

运行限制为 120 秒和 16 MiB 日志输出。取消会停止当前进程组，但不是宿主隔离。Python 可访问宿主文件和网络；运行器不会主动传入交易凭据。不得借 Python 绕过交易或长期指引确认，也不要启动脱离运行器管理的后台任务。

临时计算成为正式结论依据时，保留完整必要记录并在所属正文中引用。移动或复制记录后保留旧路径可读，不让原有 evidenceRef 失效；运行记录不自动清理。
