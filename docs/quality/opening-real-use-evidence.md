# 开学版真实使用审查：证据与可复现记录

关联：[审查报告 RU-01–07](opening-real-use-audit.md)。采集日期：2026-09-13；基线 HEAD `0d9d287bb8210c7af10a9c1df87145242f972372`。
状态：研究记录，不是产品交付证明。只读材料/源码探针＋公开文献核查；未修改业务代码或原件。

## E01 — 范围、资产与反证

- 权威范围：`docs/superpowers/specs/2026-09-12-opening-release-design.md`；执行：`docs/superpowers/plans/2026-09-12-opening-release-implementation.md`、`opening-release/{interfaces,01-foundation,02-ingestion,03-tutor,04-memory,05-learning,06-planning,07-experience,08-delivery,traceability}.md`。
- 对照已存在的 `docs/quality/opening-plan-audit.md` PA-01–10 与 `opening-plan-research-backlog.md` R01–R08；这些尚未提交的草稿未被本轮改写。
- 初始工作区：`M docs/brainstorm/INDEX.md`；上述两份 quality 文件 untracked。没有将它们当作本轮产物或已批准修正。
- 用户证据：当前对话的教师邮件和两个指定 PDF；长期使用要求以已批准规格为准。未读取邮件账户、其他聊天记录或 .env。
- 代码反证：`apps/web/src/app/api/courses/route.ts:9–30` 已有 POST/GET；`features/auth/service.ts:966–1009` 绑定 principal 后调用 course repository。新 opening 接入未定义，不代表旧课程功能不存在。
- 本轮源码检查限于课程/资料复用及已知 opening 边界；不是全仓安全审计。未将所有计划中的未实现功能记为缺陷。

## E02 — 两个真实 PDF 的本地探针 [V]

工具：Python 3.13 系列、PyMuPDF `1.27.2.3`、pypdf `6.16.2`；本机未安装 Docling。探针工具不自动成为生产依赖选型，部署许可/依赖另核。

| 文件 | 字节 | SHA-256 | 页数（两库一致） |
|---|---:|---|---:|
| BASIC_NOTIONS_LATEX_SLIDES.pdf | 407381 | aa28e730082d211c176cbc01ef38e473b171c1ba4b312fa4c76044f1c5d7693d | 58 |
| WolframAlpha_Guide_Mathematics_I.pdf | 71374 | f9f6fb57f55bb276e743eb7b7572b08eeb64d35a1ee2ab1ffa1bbb43858bb0a3 | 3 |

- 两库对全部61页均提取到非空文本；这不是61页公式正确率。
- 课件封面未印页码，其他页包含2–42编号；14个编号重复，对应42张逻辑幻灯片含封面。比如编号24对应物理页35–37。
- 物理页4和5去空白文本相同；使用相同参数渲染后的像素hash不同。不能从文本重复推导视觉重复。
- texttrace 检查未发现 opacity=0 或 type=3 的span；不据像素差异推断存在隐藏答案泄漏。
- exercise/appendix 文本命中物理页2、25、58；末页指向 `Appendix of the notes`。未找到完整20题及解答，不把缺失附录当作已收到。
- pypdf 输出多条 `Ignoring wrong pointing object ... (offset 0)`，解析仍结束；未修复原PDF，未证明这些警告无害。目录/页数用另一库交叉核对，逐式视觉金标仍未完成。
- 当前主模型工具未能展示页面图像；图像比较是程序比较，不声称人工看过每页。

复现（仅打开用户授权的两个本地文件，不联网）：

```bash
PYTHONIOENCODING=utf-8 python - <<'PY'
import fitz, pypdf, pathlib, hashlib, re
base = pathlib.Path.home() / 'Downloads'
for name in ['BASIC_NOTIONS_LATEX_SLIDES.pdf',
             'WolframAlpha_Guide_Mathematics_I.pdf']:
    path = base / name
    a, b = fitz.open(path), pypdf.PdfReader(path)
    assert len(a) == len(b.pages)
    print(name, 'pages=', len(a), 'sha256=',
          hashlib.sha256(path.read_bytes()).hexdigest())
    assert all(p.get_text().strip() for p in a)
    assert all((p.extract_text() or '').strip() for p in b.pages)
    if name.startswith('BASIC'):
        norm = lambda p: re.sub(r'\s+', '', p.get_text())
        same_text = norm(a[3]) == norm(a[4])
        same_pixels = a[3].get_pixmap().samples == a[4].get_pixmap().samples
        print('physical 4/5:', same_text, same_pixels)
        assert same_text and not same_pixels
PY
```

实测结果：`58 / 3`；`sameExtractedText=true`、`sameRenderedPixels=false`。不把 PyMuPDF/pypdf 结果外推为 Docling 或任一视觉模型效果。

## E03 — 实际 repository 的 source 复用限制 [V]

`packages/database/src/repositories/course-membership.ts:250–299` 显式拒绝尚未接入的 assetType；`interfaces.md:33` 却拟直接复用该 membership 模型。
下面使用实际 repository、假 SQL 返回两条合成读取；不连接数据库、不调用模型，不绕开真实源码分支：

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createCourseMembershipRepository } from './packages/database/src/repositories/course-membership.ts';
const w='00000000-0000-4000-8000-000000000001';
const c='00000000-0000-4000-8000-000000000002';
const s='00000000-0000-4000-8000-000000000003';
let reads=0;
const sql=async (parts,...values)=>{
  reads++;
  const q=parts.join('?').replace(/\s+/g,' ').trim();
  if(q.startsWith('SELECT id FROM workspaces')) return [{id:w}];
  if(q.startsWith('SELECT * FROM courses')) return [{id:c,workspace_id:w,
    title:'Synthetic mathematics',slug:'synthetic-math',description:'',
    schema_version:1,created_at:new Date(0),updated_at:new Date(0),archived_at:null}];
  throw new Error('Unexpected SQL in read-only probe: '+q);
};
await assert.rejects(createCourseMembershipRepository(sql).addAssetMembership({
  workspaceId:w,courseId:c,assetType:'source',assetId:s,role:'core',visibility:'private'
}),error=>{
  assert.equal(error.code,'VALIDATION');
  assert.equal(error.message,'Asset type not yet membership-backed: source');
  console.log('RU-PROBE membership:',error.code,error.message);return true;
});
assert.equal(reads,2);
console.log('RU-PROBE scope: actual repository + fake SQL, 2 reads, 0 writes, no database connection');
JS
```

实际输出：`RU-PROBE membership: VALIDATION Asset type not yet membership-backed: source`；`2 reads, 0 writes, no database connection`。
这是“不能直接复用”的复现，不是修复后通过，更不是实际 PostgreSQL 鉴权验收。修正时须扩展受限所有权解析和对应测试，不能直接移除拒绝分支。

## E04 — 公开技术来源：实取正文/源码，不只看搜索摘要 [V]

本轮主线程请求8份有效公开正文/元数据，均HTTP200；另1次PubMed得到cookie页，见E07。未发送用户课件或对话，未向产品模型API发送请求。

| ID | 取得的原始URL / 版本 | 直接证据与边界 |
|---|---|---|
| S01 | https://pypi.org/pypi/docling/2.126.0/json | version=2.126.0；requires_python=`<4.0,>=3.10`；MIT元数据；依赖`docling-slim[standard]==2.126.0`；上传2026-09-04。Python3.12满足声明，不证明全依赖安装/模型许可 |
| S02 | https://raw.githubusercontent.com/docling-project/docling/v2.126.0/docling/datamodel/pipeline_options.py | 固定tag源码1967–1984行：`do_code_enrichment=False`、`do_formula_enrichment=False`。普通转换不默认启用公式增强 |
| S03 | https://docling-project.github.io/docling/usage/enrichments/ | 当前文档：公式增强生成LaTeX；额外模型会增加处理时间，多数增强默认关闭。属于功能文档，不是本机质量/耗时实测 |
| S04 | https://pypdf.readthedocs.io/en/stable/user/extract-text.html | 当前stable文档：“Mathematical Formulas ... indices and nested fractions”；“pypdf is not OCR software”；布局/文本顺序不自动恢复数学语义 |
| S05 | https://platform.openai.com/docs/guides/pdf-files | 重定向至 https://developers.openai.com/api/docs/guides/file-inputs ；PDF视觉模型输入同时包含文本和页图；非PDF嵌图不会等价带入；单文件under50MB、请求合计50MB。不可泛化到任意兼容baseURL或其他供应商 |

S05另明确页图增加token；不能用本地文件字节数或抽取字符数估算全部模型输入成本。项目上传50MiB默认与供应商50MB限制不是自动相等的契约，须由adapter另行校验；这不构成选择该供应商或购买预算的决定。

获取内容SHA-256（可用原始响应字节核验；当前站点会变化）：
- S01 `dc4a0e3285397cacace8e455351a8189aeda57f1d06ea252b5151a9472ad24e1`
- S02 `a48db6eeebf387365fe32feecfb1e967d684a61f2f028f43b02922e22f6cfe4d`
- S03 `bf7dfcedd4d30583fa2534e15a336a01f81654202ee427ceb72e5ee6c7a46507`
- S04 `8928470fec52f3c9e8f13422871aa3f0e9c21017f9de3539037daf1388ac1af0`
- S05 `cce25993d156996944c24a9b8f7f47580ad20b128c086ebea1842e4499159a5e`

复核方式：对相同公开URL执行 `urllib.request.urlopen(..., timeout=25)`，记录HTTP状态/finalURL，原始bytes做sha256；HTML转文本后核对上表短引文。无需API key。

## E05 — 学习研究：支持最小闭环，不支持夸大个性化效果 [V/H]

| ID | 来源 | 本次核查到什么 |
|---|---|---|
| S06 | https://ies.ed.gov/ncee/wwc/PracticeGuide/1 | IES/WWC《Organizing Instruction and Study to Improve Student Learning》，2007-09；含间隔学习、交替例题/独立练习、图文结合、解释性问题 |
| S07 | https://ies.ed.gov/ncee/wwc/Docs/practiceguide/20072004.pdf | 63页完整文件已取得；核对建议表及Recommendation2。PDF物理20页标交替例题/解题证据Moderate，15/21页说明能力提高后减少示例；不把所有建议统一称Strong |
| S08 | https://api.crossref.org/works/10.1111/j.1467-9280.2006.01693.x | Roediger与Karpicke，2006，Test-Enhanced Learning；本次读到元数据与摘要，未读全文。两实验材料为prose passages，5分钟/2天/1周测验；立即重学优势与延迟检索优势不同 |

原始响应hash：S06 `475680c2dfd73b825338426aa68b635f212cc1c42cca915574565135f28a1cab`；S07 `5e6a7602f80c3856875e5461aab1b1d20404dcf8dd761d34b9cd8698b9196154`；S08 `010671d1595cc81aa300fed67ea6f5556cd906918e9c96badb1a60329a3d2ff2`。

推论：让初学者选择示例→解释→独立尝试，再保留延迟观察，是有依据的候选设计；“看懂”与“独立完成”要分开。限制：摘要中的2天不是个人最优间隔；散文自由回忆不等于数学证明迁移；指南不是针对本用户的随机试验。未测本项目学习收益，不修改L02启发式为“已校准”。

## E06 — 本轮实际验证输出 [V]

```text
$ node scripts/validate-opening-plan.mjs
Plan structure: PASS (27 tasks, acyclic dependencies, plan/evidence files present)
Ready tasks: F01, F02
This checks plan integrity, not application correctness or learning effectiveness.
$ node --test tests/tooling/opening-plan.test.mjs
tests 4
pass 4
fail 0
```

E02/E03是本轮执行的探针；AC01–12 产品验收映射已挂入 `docs/superpowers/plans/opening-release/traceability.md`（任务 ID + 拟跑命令骨架，探针实现仍等 F02 verified），不混用“已通过产品验收”状态。没有重跑旧审查中的planner/assessment探针，也没有将旧B00–B02记录当作本轮构建通过。

## E07 — 失败、处理及未验证边界

- 初次并行 reviewer/researcher 运行 `mtzkneci-1b3b8986` 均240秒超时，无最终报告；状态查询无活动任务。记录显示读文件/外部读取仍在进行，超时根因未完全定位；不称独立审查完成、不重跑原广范围请求。
- 改为最多4次读取、只反证RU-02/03/04/07的限定reviewer任务 `mtzlbn8a-b4ac4d2e`，已返回。未发现足以推翻上述契约缺口的反证，建议将RU-07限定为M1用户可用含义未被UI覆盖。只采纳其文档一致性判断；其提到的sourceTurnIds实际属LearningObservation而非ObservationInput，主线程已核对。
- PubMed `https://pubmed.ncbi.nlm.nih.gov/16507066/` 返回HTTP203，正文为“Cookies must be enabled”，不是论文；改查公共Crossref DOI元数据/摘要取得200，不将其冒充全文。
- 初次rg包含不存在的 `repositories/workspace.ts`/`schema/workspace.ts`，后用文件清单定位到真实`courses.ts`和`course-membership.ts`；没有据错误路径声称功能不存在。
- 开始时graphify仅cache，无graph.json/wiki，按仓库规则用rg/read定位。此前标准update超时；本轮先核CLI帮助，采用支持的 `graphify update . --no-cluster` 排除聚类工作量，仍90秒超时。输出745/745 AST扫描，6配置文件零节点、16 SQL文件缺tree_sitter_sql。**降级未解决；不能认定超时由聚类或SQL依赖造成**。未盲重试、未安装依赖，未报告图谱更新成功。
- 未执行：Docling安装/真实转换、产品模型API调用/费用核算、DB/Redis/S3集成、真机、部署恢复、业务lint/typecheck/build。本轮无业务代码变更；真实服务与预算未启用，不能用研究替代这些门禁。
- 临时提取正文、公开下载和探针JSON仅在系统临时目录；未将私人课件或逐页文本加入仓库。未清理用户原件或既有改动；不自动提交本轮文档。

## E08 — 文档交付检查

实际执行：两个新增文件≤200行、围栏配对、相对文档链接存在、RU/AC编号齐全，输出：

```text
DOC CHECK PASS: 2 files, 6 local links, 7 findings, 12 acceptance cases
```

`git diff --check`退出0；tracked diff仍仅是用户已有的`docs/brainstorm/INDEX.md`一行，新增的两份报告为untracked，业务文件没有本轮diff。未提交Git。报告供用户审阅，不等于批准了计划修正或完成产品交付。
