# Python 计算

FFA 使用普通 Python，不限制研究只能调用固定指标或回测协议。

默认解释器为 /usr/bin/python3。需要共享依赖环境时，由用户使用标准 Python/uv 工具准备环境，再通过 /ffa python /绝对路径/bin/python 确认解释器。不要在启动或初始化时自动安装依赖。

包内 python/requirements.lock 是可选计算库的依赖参考。ffa_python 会把 python/src 加入模块搜索路径，可导入 ffa_compute。使用前核实实际环境与方法适用性。

ffa_python 接受 code、可选 inputs 和 owner。省略 owner 时写入 scratch/runs；其他归属为 projects/名称 或 areas/名称。每次创建新的运行目录，保存 main.py、inputs.json、manifest.json、output.json 和包含标准输出、标准错误及退出码的 process.json。程序输出过大时读取产物文件，不把截断片段当成完整证据。

单次运行限时 30 秒，输出上限 2 MiB。失败或取消保留记录；重算创建新运行。进程中断可能留下 running 状态，这只表示当时开始运行，不表示当前仍在执行。不得据此自动重放。

Python 具有宿主文件和网络访问能力，不是沙箱。不要用 Python 绕过来源权限、改写 .ffa 或执行交易。已发生的外部副作用不会因取消回滚。
