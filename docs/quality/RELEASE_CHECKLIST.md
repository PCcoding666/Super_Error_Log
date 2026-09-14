# 发布检查单

## 每次交付前必过

- [ ] `npm run verify` 全绿（typecheck + 56 单测/集成 + build + 9 E2E）
- [ ] `npm run demo` 手动走一遍：上传夹具 → 校正 → 反思 → 计划 → PDF → 回传
- [ ] 生成的 PDF 用系统预览打开确认版式（题目页无答案、演算区足够、答案章独立）
- [ ] 无新增 secret 入库：`git status` 检查无 .env/密钥/真实学生数据
- [ ] `.ai/tasks/current/` 状态文件已更新（STATE/CHECKPOINT/TEST_LOG）

## 试点（真实用户）前追加

- [ ] 真实 OpenAI 兼容接口冒烟：SEL_AI_MODE=openai 上传 3 张真实错题照片，检查提取质量与置信度分布
- [ ] 真实打印机输出一份 PDF，确认 A4 黑白可读、勾选框可写
- [ ] 学生本人完整走一遍 J1–J5（观察 4 项反思的理解成本）
- [ ] 家长视图由家长本人确认"看不到题目与反思"
- [ ] 数据目录备份与清空流程演练
- [ ] RISK_REGISTER 中 R1/R2（git 历史中的旧 secret）处置结论确认
