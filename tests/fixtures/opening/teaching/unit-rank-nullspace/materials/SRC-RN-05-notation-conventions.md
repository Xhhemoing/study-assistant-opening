# 记号约定摘要（讲解用）

<!-- page:1 -->

本材料是 `symbols.md` 的课堂可读摘要，便于引用锚点。完整权威约定见同单元 `symbols.md`。

## 本单元统一写法

- 矩阵：$A\in\mathbb{R}^{m\times n}$
- 零空间：$N(A)$（不用未说明的 $\ker$ 作为金标准）
- 列空间 / 像：$\mathrm{Col}(A)$ 或 $\mathrm{Im}(A)$
- 秩：$\mathrm{rank}(A)=\dim\mathrm{Col}(A)$
- 零度：$\mathrm{nullity}(A)=\dim N(A)$
- 定理：$\mathrm{rank}(A)+\mathrm{nullity}(A)=n$（$n=$ 列数）

<!-- page:2 -->

## 样例钩子的标准矩阵

$$
T(x,y)=(x+y,0)
\quad\Longleftrightarrow\quad
[T]=\begin{bmatrix}1&1\\0&0\end{bmatrix}.
$$

向量一律按**列**书写。求零空间与秩时以 **RREF** 为准。

## 不要这样说（讲解禁令）

- 「你已掌握 90%」类伪造掌握率  
- 把「换两个数字的同一题」宣传为「迁移成功」  
- 把 citation ID / sourceId 当作「事实已核验」  
- 未化简就按对角线非零个数报 rank  
- 把 $N(A)$ 与 $\mathrm{Col}(A)$ 说成同一个集合
