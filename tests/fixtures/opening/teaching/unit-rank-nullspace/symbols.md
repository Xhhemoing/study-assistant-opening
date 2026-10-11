# 符号约定（rank-nullspace-v1）

本单元所有讲解例、典型错误纠正、held-out 金标准均按下列约定书写与核验。**不要**与其它教材/课程的临时别名混用，除非活动显式声明「对照记号」。

## 矩阵与空间

| 记号 | 含义 | 备注 |
|---|---|---|
| $A \in \mathbb{R}^{m \times n}$ | 实矩阵，$m$ 行 $n$ 列 | 默认实数域；复数另标 |
| $N(A)$ | nullspace / 零空间：$\{x \in \mathbb{R}^n : Ax=0\}$ | 亦写作 $\mathrm{Nul}(A)$；本单元统一用 $N(A)$ |
| $\mathrm{Col}(A)$ / $\mathrm{Im}(A)$ | column space / 列空间 / 像 | 二者在本单元互换使用，指 $A$ 的列张成的子空间 |
| $\mathrm{rank}(A)$ | $\dim \mathrm{Col}(A)$ | 等于主元列个数（经 RREF 后） |
| $\mathrm{nullity}(A)$ | $\dim N(A)$ | 等于自由变量个数 |
| rank-nullity | $\mathrm{rank}(A)+\mathrm{nullity}(A)=n$ | $n$ 为列数（输入维） |

## 向量与运算

- 向量默认写成**列向量**。
- 行阶梯形 / 简化行阶梯形记为 RREF；求 $N(A)$、$\mathrm{rank}$ 时以 RREF（或等价行变换）为依据，**不要**仅看未化简对角元。
- 线性变换 $T:\mathbb{R}^n\to\mathbb{R}^m$ 的标准矩阵记为 $[T]$；样例钩子 $T(x,y)=(x+y,0)$ 对应 $[T]=\begin{bmatrix}1&1\\0&0\end{bmatrix}$。

## 仅在显式需要时使用

- 左零空间 $N(A^\mathsf{T})$：本单元**默认不讲**；仅当材料或题目显式提到时才引入。
- 特征值 / 特征空间：不与零空间自动等同；「零特征值个数 = nullity」仅对可对角化等特殊情形成立，**不得**作为一般定义或一般算法。

## 明确不混用

- 不用「核 / kernel」符号 $\ker$ 与 $N(A)$ 并列而不说明它们同义（讲解中可一句等同，金标准统一写 $N(A)$）。
- 不用「维数亏损」等未定义口语代替 $\mathrm{nullity}(A)$。
- 不把「主元个数」说成「非零对角元个数」而不经 RREF。
- 不把 citation / sourceId 当作已核验事实标记。

## 权威引用

本文件路径：`tests/fixtures/opening/teaching/unit-rank-nullspace/symbols.md`  
`manifest.json` 的 `symbolConvention` 指向本文件。
