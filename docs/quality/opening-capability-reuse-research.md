# 学习能力扩展：开源复用核查

核查时间：2026-09-14 UTC。范围：公开仓库元数据、README/许可证和官方文档；未安装依赖、未连接学校邮箱/钉钉、未使用用户密钥、未跑真实模型。

## 1. 结论与选型

| 能力 | 推荐复用 | 直接观察 | 仍需验证 |
|---|---|---|---|
| 学校自建邮箱 | ImapFlow + MailParser | Node.js IMAP客户端及流式MIME解析；包元数据声明MIT，许可证原文为宽松许可文本 | 学校是否开放IMAP、认证方式、TLS链、实际附件/断线行为、发布制品 |
| 完整邮件接入服务备选 | EmailEngine | 统一REST、同步及webhook；商业EmailEngine License，14天试用后需有效许可证 | 用户是否接受订阅、部署成本、Redis持久化与隐私；不默认采用 |
| 课件解析 | 沿用Docling候选 | 仓库MIT；已有F02钉住2.126.0的研究记录 | 本轮未重测该版本、公式与PPT图像质量；不自动升级至仓库HEAD |
| 录音转写 | faster-whisper | 仓库MIT，基于CTranslate2的Whisper实现 | 模型权重许可、中文夹英文/公式、硬件、耗时和内存 |
| 视频处理 | FFmpeg | 官方说明基础LGPL-2.1-or-later，启用部分组件后可能转为GPL | 实际二进制编译选项、编解码器许可、安全限制、性能 |
| 资料辅导/知识结构参考 | DeepTutor | 仓库声明Apache-2.0，个性化辅导项目 | 具体子模块、依赖/模型许可、与本项目证据规则的兼容；未证明教育效果 |
| 钉钉接入 | 官方开放平台/SDK | 官方入口返回页面外壳 | 本轮未取得可核对的具体API权限正文；C03必须对实际应用逐项验证，不宣称能读全部群聊 |

不能因为仓库公开就认定可免费部署。ImapFlow/MailParser的GitHub license API返回`NOASSERTION`，因此又读取LICENSE原文与package.json，没有将分类失败解释成“无许可”。实际分发前按固定制品再核对条款和第三方依赖。

## 2. 可复查来源

- ImapFlow：https://github.com/postalsys/imapflow
  - 核查提交：`58ef92c1a09fd1e1da1af3564e3a13777c150536`。
  - 该提交package.json为`2.0.2`、Node `>=20.0.0`、`license: MIT`；不等于已确认npm发布。
  - https://github.com/postalsys/imapflow/blob/58ef92c1a09fd1e1da1af3564e3a13777c150536/LICENSE.txt
  - https://imapflow.com/docs/ — README列出IDLE/CONDSTORE/QRESYNC自动适配和消息流式读取。
- MailParser：https://github.com/nodemailer/mailparser
  - 核查提交：`7826284ce2ff788747bd628d6936bf03d22e0df2`；package.json为`3.9.26`、Node `>=20.0.0`、`license: MIT`。
  - https://github.com/nodemailer/mailparser/blob/7826284ce2ff788747bd628d6936bf03d22e0df2/LICENSE
  - https://nodemailer.com/extras/mailparser — 文档明确**不净化HTML**；大邮件使用流式MailParser，避免simpleParser把附件全部放入内存。本产品默认纯文本展示、不取远程图片。
- EmailEngine：https://github.com/postalsys/emailengine
  - 核查提交：`d2089c3c6ab0a4b0c49e2d76a4fa62dc642bdd58`；package.json为`2.80.1`、`LICENSE_EMAILENGINE`。
  - https://github.com/postalsys/emailengine/blob/d2089c3c6ab0a4b0c49e2d76a4fa62dc642bdd58/LICENSE_EMAILENGINE.txt — 2.1–2.4、3.1–3.3、6.1–6.4规定试用、订阅和源码使用限制。
  - README特别指出Redis是主数据库而非缓存，必须防驱逐；不能仅因为现有系统也用Redis就认为没有运维增量。
- https://github.com/SYSTRAN/faster-whisper/tree/ed9a06cd89a93e47838f564998a6c09b655d7f43
- https://github.com/docling-project/docling/tree/5ea6490ffdc57b2fd7de5cc436f2d0a22f2214d4
- https://ffmpeg.org/legal.html — 已读取官方许可正文；不要笼统标作MIT。
- https://github.com/HKUDS/DeepTutor/tree/2e0816b090b298a91bc5cceca9ac8d73ce6dbaa6
- https://open.dingtalk.com/document/development/read-before-development — 当前只取得页面外壳，无具体权限结论。

## 3. 不重复造轮子，但保留业务责任

直接复用：IMAP握手/能力协商、MIME字符集与附件解码、媒体解码、语音模型推理、文档版面解析。
本项目保留：授权范围、幂等同步与私有来源关系、学校通知更正、课程知识节点与个人作答的连接、版本化计划、删除语义。
不同时部署EmailEngine和自有IMAP同步器；先用两库方案，只有实际测试证明运维/兼容成本更低且用户批准商业许可后才切换完整服务。
不以复杂GraphRAG、图数据库或自训练知识追踪模型为知识结构的首个前提；先实现可引用、可修订、能驱动下一道题的小型课程图。

## 4. 工具失败与证据边界

npm registry的三次元数据请求出现`SSL: UNEXPECTED_EOF_WHILE_READING`，因此改读GitHub固定提交package.json；未把源码版本当作已发布制品或已安装版本。
同一批输出遇到Windows默认编码的`UnicodeEncodeError`，改为UTF-8后取得官方文档输出；不是被测产品失败。
学校自建邮箱的域名、IMAP端口和学校授权策略未知；不猜厂商，不以HTTP登录页可访问推断IMAP可用。接入验证需用户提供帮助页或非秘密连接信息，密码只通过正式安全配置流程输入。

本报告支持复用选型与实施门禁，不支持“服务已接通”“转写已准确”或“学习效果已提高”的结论。

## 5. 本轮计划变更验证

- 失败：新增`tests/tooling/opening-capability-plan.test.mjs`首次运行8项，1通过/7失败，明确缺少CAP01–06映射及Q04扩展门禁。
- 根因：旧27项计划只覆盖五项基础功能，缺少多源接入、媒体理解、课程知识结构及主动辅导的独立交付责任。
- 修正：增加X01/C01–C03/V01/K01–K02/P04/U04/Q04共10项，更新范围补充、总计划、共享协议与验收映射，旧任务状态不改。
- 复查：`node --test tests/tooling/opening-plan.test.mjs tests/tooling/opening-capability-plan.test.mjs`：`tests 13 / pass 13 / fail 0`；覆盖传递验收依赖及总计划/子计划/manifest一致性。
- `node scripts/validate-opening-plan.mjs`：`Plan structure: PASS (37 tasks, acyclic dependencies, plan/evidence files present)`；`Ready tasks: P01, X01`。
- 新增测试文件ESLint通过；6份新文档的本地链接、占位标记和代码围栏检查通过；`git diff --check`无空白错误，只有已有LF/CRLF转换提示。
- `graphify update .`成功更新代码图：11775节点、25554边；19个SQL文件因缺`tree_sitter_sql`未解析，6个配置文件零节点；此次AST更新不证明新文档语义已进入图。
- 本轮仅修改计划/规格/研究说明和计划检查测试，未安装库、迁移数据库、改业务代码或部署。新增功能仍为planned；实际验收按Q04执行。

