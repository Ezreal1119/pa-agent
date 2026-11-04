# 正式 Library 首次调用翻译与摘要维护 API

用户明确授权后，依次对本机正式 `.data/ckd/library/ckd-library-v2` 发起两个 API 请求，均使用空筛选 `{}`。调用前确认没有其他正在执行的 SOP 或维护任务；保存 2,695 个资料文件的修改前 Hash。

## 翻译已完成

POST `/api/library/translate`，任务 ID `897ac147-5c9f-4017-97eb-12ea936fb842`。

处理 1,326 项：更新 4、复用 925、保留已有独立内容 397、错误 0、冲突 0。

更新的是 GPOS710 / pcba_test 下四个工序的中文 `tools_fixtures_equipment.jsonl`，对应此前原文语法错误导致未补齐的表格：MCU_Download_Operation、MotherBoard_Writenumber、Software_environment_setup、WriteNumber_Fixture_Build。源文件为空时保留空文件，不编造内容。

## 摘要维护已启动

翻译完成后调用 POST `/api/library/summaries`，任务 ID `16c84547-9f08-4b30-ba3f-62821af1b1f8`，共 310 个工序/项目/语言范围。启动后正在处理 SQ610 装配资料，包含需要首次识别的图片；本条记录不将后台任务写成已完成。

最终状态、逐项结果及备份在 `.data/ckd/library-jobs/<task-id>/`；HTTP 查询 GET `/api/library/jobs/16c84547-9f08-4b30-ba3f-62821af1b1f8`。关闭页面不会取消后端任务，后端进程中断时需显式 resume。

本轮调用审计目录：`.data/ckd/maintenance-runs/2026-10-08T11-05-22-027Z/`，包含修改前 Hash、各阶段任务结果；顺序执行脚本在摘要任务结束后保存语法检查及修改后 Hash/变更清单。以其中的 `report.json` 和持久化任务状态为最终执行依据。

本轮没有修改通用 Core 或 patrick-agent，也没有运行旧项目的维护器。

## 完成状态追加

后台顺序调用于 2026-10-08 19:49（Asia/Shanghai）结束。translate 完成，更新 4、复用 925、跳过 397，错误/冲突 0。summaries 完成全部 310 个范围的尝试，更新 286、失败 24，最终 partial_failed；主要为描述/概述翻译未通过数字、技术标识或字面量保留校验。失败项未作为成功摘要提交，具体清单在任务 state.json 与调用 report.json 中，不能宣称整个 Library 摘要已最新。随后 validate 检查 1136 个文件，语法错误 0。

本次图片校准开发仅记录此完成事实，未自动放宽翻译校验或重试/重写失败项。维护没有再运行模型后，确认运行中任务为空，才更新 4317 服务。
