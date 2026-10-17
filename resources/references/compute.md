# Python 计算

## 环境

所有 ffa 工作区共用当前系统用户的独立 Python 3.11+ venv。Linux 默认位于 `${XDG_DATA_HOME:-~/.local/share}/ffa/python/.venv`（只使用绝对 XDG_DATA_HOME），macOS 位于 `~/Library/Application Support/ffa/python/.venv`。不与系统或项目 Python 混装依赖。

就绪工作区启动时自动执行 setup：环境不存在时创建，依赖不匹配时按锁文件安装，已匹配时只检查。成功后在当前 Pi 进程激活，主会话和专家通过 Bash 使用 python 或 python3 即可。无需逐工作区配置路径，也没有 Python 计算执行工具。

主会话提示给出环境状态。状态未就绪、启动有错误或计算依赖异常时说明问题，修复后用 `/ffa python setup` 重试；不自动退回系统 Python，不删除或重建有问题的环境。额外依赖或环境变更须取得用户同意。项目构建和测试明确要求另一环境时，按项目约定在对应命令中使用。

自动安装可能按锁定版本升级或降级，影响所有共用环境的工作区。setup 串行执行，但不管理其他 Python 进程；更换插件版本或手工重试前，应停止使用共享环境的脚本，避免依赖更新干扰运行。不同插件版本的依赖锁可能冲突，不宜同时使用不同版本。激活只影响当前 Pi 及其子进程，不修改系统 Python、外部终端或 shell 配置，也不是文件或网络沙箱。

[requirements.lock](../../python/requirements.lock) 锁定 setup 安装的依赖。直接使用原生 API，按任务导入，不需要一次导入全部库；列入清单不证明环境已就绪。

## 预装原生库

| 库 | 常用导入 | 用途 |
| --- | --- | --- |
| NumPy | `import numpy as np` | 数组与数值运算 |
| pandas | `import pandas as pd` | 行情表、时间序列和文件读写 |
| TA-Lib | `import talib` | 技术指标与形态函数 |
| backtesting | `from backtesting import Backtest, Strategy` | 策略回测 |
| SciPy | `from scipy import stats, optimize, signal` | 统计检验、优化、信号处理 |
| statsmodels | `import statsmodels.api as sm` | 回归、时间序列、统计诊断 |
| scikit-learn | `import sklearn` | 预处理、预测模型、聚类与评估；导入名为 sklearn |
| Matplotlib | `import matplotlib.pyplot as plt` | 保存静态图表 |
| seaborn | `import seaborn as sns` | 基于 Matplotlib 的统计图表 |
| openpyxl | `import openpyxl` | Excel `.xlsx` 读写；也可用 pandas 的 openpyxl 引擎 |
| PyArrow | `import pyarrow as pa` | Arrow、Parquet、Feather；也可用 pandas 的 pyarrow 引擎 |
| Bokeh | `from bokeh.plotting import figure` | 交互式 HTML 图表，backtesting 绘图也使用它 |

这些库提供计算能力，不替代数据依据、统计假设或验证。时间序列建模按时间切分训练与验证数据，预处理只在训练集拟合，避免未来数据泄漏。

## 脚本、模块与产物

已有脚本直接运行，不必读取全文再复制执行。按项目文档选择工作目录和入口。例如，替换以下占位路径后，从项目根目录运行脚本：

```bash
cd "/项目根目录" && python scripts/analyze.py --window 20
```

环境中只有 python3 命令时，将示例中的 python 换成 python3。包内相对导入通常使用模块入口，例如在项目根目录执行 `python -m analysis.main --window 20`。普通脚本导入同目录模块与 `-m` 的包导入遵循 Python 原生规则；不要为绕过错误随意改 sys.path。相对数据路径取决于工作目录或脚本自己的路径处理，应先核对约定。临时计算也可使用 `python -c` 或标准输入。

输入文件、命令行参数和结果位置由脚本或项目约定决定。ffa 不复制源码、不创建输入文件、运行目录或计算记录，也不提供独立的计算超时管理；执行限制与取消由实际使用的 Bash 工具或进程管理方式决定。需要复用的研究按任务保存源码、参数、数据来源、时间、单位和结果引用；正式产物归关联项目或长期事务，临时产物使用 scratch。历史计算记录保持原样，不自动重算或清理。

Python 具有宿主文件和网络权限，不是沙箱；不得用于绕过能力提供方权限、改写 .ffa/ 或执行业务变更。取消不回滚已发生的副作用。

## 绘图与文件

在无交互式图形界面的执行环境中使用 Matplotlib/seaborn 时，在导入 pyplot 或 seaborn 前选择 Agg 后端，保存图像并关闭 figure，不调用 `plt.show()`：

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([1, 2, 3], [10, 12, 11])  # 示例数据，不是行情证据
fig.savefig("chart.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

文件按项目约定保存并交回实际产物路径；相对输出路径基于所选工作目录。Excel 可用 `pd.read_excel(path, engine="openpyxl")` 与 `df.to_excel(path, index=False, engine="openpyxl")`；Parquet 可用 `pd.read_parquet(path, engine="pyarrow")` 与 `df.to_parquet(path, index=False, engine="pyarrow")`。Feather 使用 `pd.read_feather` / `df.to_feather`。检查读写后的字段类型、时间单位与时区；Excel 不直接保存带时区的 datetime，转换前明确目标时区，不默默丢弃时区含义。

## TA-Lib 技术指标

使用原生 API，不需要指标包装层。常用函数包括 `SMA`、`EMA`、`MACD`、`RSI`、`BBANDS`、`ATR`、`ADX`、`STOCH`、`OBV` 和 `CDL*` 形态函数。用 `talib.get_function_groups()` 或 `talib.get_functions()` 查找能力，用 `help(talib.函数名)` 核对参数与返回值，不凭名称猜测。

以下脚本从第一个命令行参数指定的 JSON 文件读取 close 数组，计算均线并输出严格 JSON：

```python
import json
import sys
import numpy as np
import talib

with open(sys.argv[1]) as file:
    data = json.load(file)
close = np.asarray(data["close"], dtype=np.float64)
sma = talib.SMA(close, timeperiod=20)
print(json.dumps({"sma20": [float(x) if np.isfinite(x) else None for x in sma]}, allow_nan=False))
```

使用前核对时间顺序、复权口径、缺失数据、单位和样本长度。多输入函数要求 OHLCV 数组按同一时间轴对齐。backtesting 策略可通过 `self.I(talib.SMA, self.data.Close, 20)` 注册指标。

- `talib.MACD` 返回 `(macd, signal, hist)`，`hist = macd - signal`，不乘 2。
- `talib.BBANDS` 返回 `(upper, middle, lower)`，默认使用 SMA 中轨和两倍总体标准差。
- 暖机期输出 NaN；例如 SMA(20) 前 19 根、RSI(14) 前 14 根不可用。EMA、RSI 等按 TA-Lib 的种子与平滑规则计算，不等同于直接 pandas ewm。
- NaN 输入可能影响后续输出，不擅自填零或把暖机值当成信号。持平序列的 RSI 在暖机后为 0，不是 50。
- 指标可计算不证明策略有效。记录参数、TA-Lib 版本与数据依据；生成严格 JSON 时把非有限值转为 null。

## backtesting 原生回测

直接使用 `from backtesting import Backtest, Strategy`。继承 Strategy 定义 `init()` 和 `next()`，通过 `Backtest(data, 策略类, ...).run()` 运行。数据使用按时间升序的 OHLC DataFrame，可带 Volume，建议使用 DatetimeIndex；以当前安装版本的 API 为准。

- 显式确定资金、手续费、价差、成交时点与仓位假设，不把库默认值当作投资规则。
- 原生 Backtest 不自动提供 A 股 T+1、整手买入、涨跌停或交易日历约束。研究需要这些规则时，必须明确建模并验证；无法表达时说明限制，不能直接声称结果适用于该市场。
- 按研究问题决定是否划分样本内/样本外及如何暖机，不默认套用固定回测流程。避免未来数据泄漏。
- 原生结果可能包含 Series、DataFrame、时间和非有限值；按需要提取统计与交易记录，再转为可保存的数据，保留数据来源、参数及库版本。

环境与许可信息见 [Python 说明](../../python/README.md)。
