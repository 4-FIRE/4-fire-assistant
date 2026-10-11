# Python 计算

## 环境

ffa_python 运行普通 Python 源码。默认解释器为 /usr/bin/python3；共享环境由用户用 Python/uv 准备，通过 /ffa python /绝对路径/bin/python 确认。依赖安装需另行取得用户同意。

[requirements.lock](../../python/requirements.lock) 列出可选计算库依赖。工具把包内 python/src 加入模块搜索路径，可导入 ffa_compute；导入成功不表示全部可选依赖已安装。

## 输入与产物

参数为 code、可选 inputs 和 owner。运行目录是进程工作目录，可从 inputs.json 读取传入数据。省略 owner 时保存到 scratch/runs；其他归属为 projects/名称 或 areas/名称。

每次运行创建新目录，保存 main.py、inputs.json 和 manifest.json；进程返回后保存 output.json 和包含标准输出、标准错误及退出码的 process.json。工具结果带 truncated=true 时，从运行目录读取完整产物。需要复用的计算保留数据来源、时间、单位及参数依据，与产物一起引用。

单次运行限时 30 秒，输出上限 2 MiB。失败或取消也保留记录；重新运行创建新记录。进程中断留下的 running 状态不证明计算仍在执行。额外产物可写入运行目录，供后续读取。

Python 具有宿主文件和网络权限，不是沙箱；不得用于绕过来源权限、改写 .ffa/ 或执行业务变更。取消不回滚已发生的副作用。

## 可选计算库

仅在使用包内实现时阅读对应源码：

- [indicators.py](../../python/src/ffa_compute/indicators.py)：sma、ema、macd、rsi、boll。输入为 Series 或数组，输出为等长数组；MACD 柱使用两倍差值，BOLL 标准差使用 ddof=0，暖机和缺失值行为依函数而异。
- [engine.py](../../python/src/ffa_compute/engine.py)：run_backtest 接受策略类、OHLCV DataFrame 和实验参数，返回 metrics、series、trades、rejections，不自行保存文件。
- [broker.py](../../python/src/ffa_compute/broker.py)：A 股单标的日线交易约束与费用实现。

run_backtest 分别运行 full、IS 和 OOS；IS/OOS 独立初始化资金和暖机。默认资金、费用、价差及切分比例是库参数，不是用户投资规则。多头日线模型存在同批 T+1 数量过滤简化，未建模涨跌停和独立交易日历。范围外的问题使用其他适用方法。

依赖与许可信息见 [计算库说明](../../python/README.md)。
