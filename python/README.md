# Python 共享虚拟环境

所有 ffa 工作区共用当前系统用户的独立 Python 3.11+ venv。通过 Bash 使用 `python` 或 `python3` 执行普通脚本或模块，直接导入第三方库；没有 Python 计算执行工具或自定义计算包。

## 自动准备与激活

就绪工作区启动或原生 `/reload` 后自动执行 setup，无需另行确认或指定路径：

1. 共享 venv 不存在时创建，不使用系统 site-packages。
2. 按 `requirements.lock` 补齐或对齐依赖，允许升级或降级；已匹配时不重新安装。
3. 检查依赖关系、全部预装库导入和简单 TA-Lib 计算。
4. 成功后将 venv 的 `bin` 放到当前 Pi 进程 PATH 前端，设置 `VIRTUAL_ENV`，移除 `PYTHONHOME`、`PYTHONPATH` 并禁用用户 site-packages。主会话与专家的原生 Bash 继承该环境。

| 系统 | 共享环境 |
| --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/ffa/python/.venv`；仅使用绝对 XDG_DATA_HOME |
| macOS | `~/Library/Application Support/ffa/python/.venv` |

首次准备从当前 PATH 选择 python3，无该命令时使用 python；需要 Python 3.11+ 和 venv/ensurepip。系统 Python 只用于创建独立 venv，不在系统环境中安装依赖。现有环境不自动替换基础解释器，也不删除额外安装的包。

首次安装可能需要数分钟和网络。未初始化或中断初始化的工作区不会在启动时准备 Python；初始化完成并 `/reload` 后才自动准备。`/ffa status` 显示环境状态。工作区关闭、重载或会话替换时恢复本扩展修改的进程环境变量，不覆盖期间其他代码对变量的新修改。外部终端和 shell 配置不变。

## 失败与手工重试

环境异常时提醒，并在状态中保留错误。ffa 的其他能力仍可使用，但不把 Python 标记为就绪，也不替模型自动换用系统 Python 执行研究。原生 Bash 仍然可用，这不是命令黑名单或系统隔离。

检查错误后可执行：

```text
/ffa python setup
```

无需路径和额外确认，执行同一准备逻辑，成功后激活。也可重启 ffa。安装限时 15 分钟，超时或关闭会取消准备；不会自动回滚或循环重试。失败留下的环境保留，不通过删除、重建或更换基础解释器修复。缺少 pip 时仅尝试该 venv 的 ensurepip。

安装只接受 wheel，不编译 C 库、不安装系统软件，不绕过系统 Python 的安装保护。没有匹配 wheel、网络不可用、权限不足或环境损坏时停止。TA-Lib wheel 包含底层库，但并非所有系统和架构都有匹配 wheel。pip 安装配置被忽略，避免包被重定向到其他目标。

多个 ffa 进程同时启动时，通过共享排他锁串行准备，后取得锁的进程重新检查。锁文件不删除。该锁不管理普通 Python 进程；更换插件版本或手工重试前，应停止使用该环境的脚本。不同插件版本可能要求不同依赖，不宜同时使用。不能承诺自动更新不会影响已运行的外部脚本。

## 独立准备

从包根目录运行也会自动准备同一共享环境：

```bash
python3 scripts/setup-python.py
python3 scripts/setup-python.py --check  # 只检查，不创建或安装
```

脚本不接受解释器或目标路径参数。独立脚本不能激活其父终端；自动激活由 ffa 完成。不修改工作区设置、脚本、历史运行记录或结果。准备脚本支持 Linux/macOS；插件其他宿主依赖仍须满足，未完成 macOS 实机验收。

## 使用与验证

setup 安装 numpy、pandas、TA-Lib、backtesting、scipy、statsmodels、matplotlib、scikit-learn、pyarrow、openpyxl、seaborn 和 Bokeh。按任务导入，参见[计算参考](../resources/references/compute.md)。市场规则、费用、成交时点和数据切分由具体研究确定，原生 Backtest 不自动提供 A 股 T+1、整手或涨跌停约束。

激活后直接执行 `python scripts/analyze.py` 或 `python -m analysis.main`。工作目录、模块导入、参数和结果位置遵循项目约定。项目构建或测试明确要求另一环境时，按项目约定执行。ffa 不复制源码、不生成输入文件或计算记录、不管理研究进程的超时。Python 与 Bash 不是文件或网络沙箱，也不授予交易权限。

在已激活环境中验证：

```bash
python -m pip check
python -B -m unittest discover -s python/tests -v
```

Node 测试使用真实本地文件、进程、临时 venv 与 Pi 原生 Bash，验证检查、错误、取消和激活恢复；不下载依赖。完整安装与库测试使用准备好的真实环境，不能以损坏环境的启动测试替代成功安装验收。Python 集成测试验证原生库配合与文件往返，不证明市场规则或策略有效；真实模型行为与 macOS 运行仍需独立验收。

依赖版本独立于插件版本。更新锁文件须检查最低 Python 3.11 与目标环境的兼容性，不只按开发机选择最新版。

## 依赖许可

[TA-Lib Python](https://github.com/TA-Lib/ta-lib-python) 使用 BSD-2-Clause，[TA-Lib 底层库](https://github.com/TA-Lib/ta-lib) 使用 BSD-3-Clause。[backtesting.py](https://github.com/kernc/backtesting.py) 0.6.6 使用 AGPL-3.0。具体版本见 requirements.lock。本包保留 private=true；对外发布前须核对依赖许可与分发义务。
