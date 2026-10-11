# 二次开发计划交付包

日期：2026-10-11
基线：Xhhemoing/study-assistant-opening @ 1a4cf465c86da7f08b6fda3044f9b0f932b80824

主文件：study-assistant-opening-v2-development-plan-2026-10-11.md
任务：tasks.json（30个proposed任务，不直接覆盖仓库原账本）
来源：sources.json（论文、官方实现、仓库文件、旧实施指南与用户共识）

## 已执行的检查

- design-checks.json / design-checks.log：20项独立设计模型检查。
- plan-validation.json：任务ID、依赖无环、来源引用和目标覆盖检查。

这些检查不针对仓库运行，不测试真实数据库并发、浏览器、模型或学生学习效果。当前观察到的仓库CI失败尚未在本轮修复。

重新运行设计小模型：

```bash
python validate_design.py
```

只需要Python标准库。脚本会更新本目录的两个design-checks输出文件，不访问互联网，不改仓库或数据库。

## 使用顺序

阅读主计划第0–13节→审查V2-00至V2-03→批准必要的契约/迁移设计→按依赖实施M1。不能将任何任务状态改为verified，除非完成其规定范围的真实验证；浏览器仍按仓库约定由用户负责。

本文提出的工程阈值与示例人数均为待确认建议，不是已有性能数据或教学效果承诺。
