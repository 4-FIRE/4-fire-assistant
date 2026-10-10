# backtest

默认只支持 CN-A 单标的、CNY、日线和多头策略。先读取 references/compute.md。使用固定数据与 Python 策略源码调用 research_compute。只按样本内结果调参，同时报告 full、IS、OOS 与买入持有基准。记录费用、资金、复权、下一根 K 线成交假设、拒绝计数和逐笔交易。样本不足或模型简化影响结论时明确说明。保存假设、实验与结果，不能用一次回测宣称策略有效。
