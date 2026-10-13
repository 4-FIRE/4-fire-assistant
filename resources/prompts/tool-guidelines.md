ffa 工具返回结构化对象；检查 success、state 或 failed 判断调用结果；协议成功不证明业务完成。

有依赖的 ffa 调用按顺序 await；确认与专家任务可能需要较长等待。取消或脚本失败不回滚已发生的副作用。

专家只用 ffa_agent。start 用 agent/message；continue 用已结束的 runId/message；这两项默认 mode=foreground，mode=background 才后台执行。运行中追加信息用 steer/runId/message，不用 continue；messageStatus=queued 不表示模型已阅读。list 返回 agents/runs；read/wait/stop 都用 runId。专家 state=completed 仅表示交付成功，不表示复核通过或获得业务许可；失败、中断、取消均须由协调者判断后续，不自动重跑。
