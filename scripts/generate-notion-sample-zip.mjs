// 生成符合 Notion HTML 导出格式的示例 ZIP，供 /preview/notion-import 展示真实解析。
// 用法：node scripts/generate-notion-sample-zip.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const pageOneId = "3f2a1b4c5d6e7f8091a2b3c4d5e6f708";
const pageTwoId = "9b2f4c1d8e7a4f6b9c3d5e7f8a9b0c1d";
const pageThreeId = "5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f";

const pageOne = `<!DOCTYPE html>
<html><head><title>概率推理笔记</title></head><body>
<article class="page">
<div class="page-header">
<h1>概率推理笔记</h1>
<table>
  <tr><td>状态</td><td>进行中</td></tr>
  <tr><td>标签</td><td>概率论 · 决策</td></tr>
  <tr><td>来源</td><td>教材第 42 页</td></tr>
  <tr><td>版本</td><td>v12</td></tr>
</table>
</div>
<div class="page-body">
  <div class="notion-text-block"><p>贝叶斯公式不是替代思考的计算器。它让我们说清楚原先相信什么、证据有多可靠，以及结论要服务于什么行动。</p></div>
  <div class="notion-heading-block"><h2>贝叶斯公式到底在说什么</h2></div>
  <div class="notion-text-block"><p>当观察到证据 <strong>E</strong> 后，我们用它更新假设 <strong>H</strong> 的可信程度。关键不在于记住符号，而在于把每个符号对应到可检查的判断。</p></div>
  <div class="notion-divider-block"><hr /></div>
  <div class="notion-text-block"><p>先验不是主观臆测的同义词。新证据进入后，后验会成为下一轮推理的先验，因此可靠的推理记录应保留这条更新链。</p></div>
  <div class="notion-toggle-block"><details><summary>从先验到后验：逐步推导</summary><div class="notion-text-block"><p>1. 写下先验 P(H)。</p></div><div class="notion-text-block"><p>2. 评估证据在假设下的可能性 P(E | H)。</p></div><div class="notion-text-block"><p>3. 计算后验 P(H | E)。</p></div></details></div>
  <div class="notion-callout-block"><blockquote class="notion-callout"><p>💡 记忆点：先验 × 似然 = 后验</p></blockquote></div>
  <div class="notion-heading-block"><h2>一个诊断测试的例子</h2></div>
  <div class="notion-text-block"><p>某疾病患病率为 1%。检测对病人的阳性率是 90%，对健康人的误阳性率是 5%。完整的推导见<a href="https://www.notion.so/Diagnostic-Example-${pageTwoId}">诊断测试的例子</a>。</p></div>
  <div class="notion-table-block"><table><tr><td>人群</td><td>数量</td><td>检测阳性</td></tr><tr><td>患病</td><td>100</td><td>90</td></tr><tr><td>健康</td><td>9900</td><td>495</td></tr></table></div>
  <div class="notion-code-block"><pre><code>const posterior = (likelihood * prior) / evidence;
console.log(posterior); // ≈ 0.154</code></pre></div>
  <div class="notion-image-block"><figure><img src="Bayes-7f3a9c2e.png" /></figure></div>
  <div class="notion-text-block"><p>所以阳性结果中真正患病者不足六分之一。<a href="https://www.notion.so/Study-Roadmap-${pageThreeId}">统计学习路线</a>里我们继续讨论如何用这一框架组织复习。</p></div>
</div>
</article>
</body></html>`;

const pageTwo = `<!DOCTYPE html>
<html><head><title>诊断测试的例子</title></head><body>
<article class="page">
<div class="page-header">
<h1>诊断测试的例子</h1>
<table>
  <tr><td>状态</td><td>已完成</td></tr>
</table>
</div>
<div class="page-body">
  <div class="notion-text-block"><p>把一万人的结果分成两栏：真正患病的人与健康的人。</p></div>
  <div class="notion-column-list-block">
    <div class="notion-column-block">
      <div class="notion-heading-block"><h3>患病人群</h3></div>
      <div class="notion-bulleted-list-block"><ul><li>100 人患病</li><li>90 人呈阳性</li></ul></div>
    </div>
    <div class="notion-column-block">
      <div class="notion-heading-block"><h3>健康人群</h3></div>
      <div class="notion-bulleted-list-block"><ul><li>9900 人健康</li><li>495 人误报阳性</li></ul></div>
    </div>
  </div>
  <div class="notion-to-do-block"><div><input type="checkbox" checked />重算一次：90 / (90 + 495)</div></div>
  <div class="notion-to-do-block"><div><input type="checkbox" />用「患病率 10%」再验证一次结论</div></div>
</div>
</article>
</body></html>`;

const pageThree = `<!DOCTYPE html>
<html><head><title>统计学习路线</title></head><body>
<article class="page">
<div class="page-header">
<h1>统计学习路线</h1>
<table>
  <tr><td>标签</td><td>路线图</td></tr>
</table>
</div>
<div class="page-body">
  <div class="notion-text-block"><p>把概率推理纳入复习闭环：</p></div>
  <div class="notion-numbered-list-block"><ol><li>回忆概念定义</li><li>独立重推诊断例子</li><li>用练习卡检验理解</li></ol></div>
  <div class="notion-callout-block"><blockquote class="notion-callout"><p>📌 学习版教材从<a href="https://www.notion.so/Probability-Notes-${pageOneId}">概率推理笔记</a>引用块，不复制正文。</p></blockquote></div>
</div>
</article>
</body></html>`;

const indexHtml = `<!DOCTYPE html>
<html><head><title>Export</title></head><body>
<h1>Notion 导出汇总</h1>
<ul>
  <li><a href="概率推理笔记 ${pageOneId}.html">概率推理笔记</a></li>
  <li><a href="诊断测试的例子 ${pageTwoId}.html">诊断测试的例子</a></li>
  <li><a href="统计学习路线 ${pageThreeId}.html">统计学习路线</a></li>
</ul>
</body></html>`;

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const zip = new JSZip();
zip.file("index.html", indexHtml);
zip.file(`概率推理笔记 ${pageOneId}.html`, pageOne);
zip.file(`诊断测试的例子 ${pageTwoId}.html`, pageTwo);
zip.file(`统计学习路线 ${pageThreeId}.html`, pageThree);
zip.file("Bayes-7f3a9c2e.png", Buffer.from(pngBase64, "base64"));
zip.file(`复习数据库 8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d.csv`, "名称,类型\n贝叶斯,概念\n后验,概念\n");

const outDir = join(root, "apps/web/public");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "notion-export-sample.zip");
const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
writeFileSync(outPath, buffer);
console.log(`written ${outPath} (${buffer.length} bytes)`);
