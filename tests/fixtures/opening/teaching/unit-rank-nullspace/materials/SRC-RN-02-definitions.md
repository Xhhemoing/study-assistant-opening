# 正式定义：零空间与列空间

<!-- page:1 -->

## 零空间 $N(A)$

设 $A\in\mathbb{R}^{m\times n}$。**零空间（nullspace）**定义为

$$
N(A)=\{x\in\mathbb{R}^n : Ax=0\}.
$$

它是 $\mathbb{R}^n$ 的子空间。$\dim N(A)$ 称为 **nullity**，记 $\mathrm{nullity}(A)$。

对几何引入中的矩阵

$$
A=\begin{bmatrix}1&1\\0&0\end{bmatrix},
$$

解 $Ax=0$ 得 $x_1+x_2=0$，故

$$
N(A)=\mathrm{span}\left\{\begin{pmatrix}1\\-1\end{pmatrix}\right\},\quad \mathrm{nullity}(A)=1.
$$

<!-- page:2 -->

## 列空间 $\mathrm{Col}(A)$ / 像 $\mathrm{Im}(A)$

**列空间（column space）**是 $A$ 的列向量所张成的子空间：

$$
\mathrm{Col}(A)=\mathrm{span}\{\text{$A$ 的各列}\}\subseteq\mathbb{R}^m.
$$

对线性变换 $T(x)=Ax$，有 $\mathrm{Im}(T)=\mathrm{Col}(A)$。本单元二者等同。

对上面的 $A$，两列是 $(1,0)^\mathsf{T}$ 与 $(1,0)^\mathsf{T}$，故

$$
\mathrm{Col}(A)=\mathrm{span}\left\{\begin{pmatrix}1\\0\end{pmatrix}\right\},\quad \mathrm{rank}(A)=\dim\mathrm{Col}(A)=1.
$$

<!-- page:3 -->

## 与几何钩子的对齐

| 概念 | 在 $T(x,y)=(x+y,0)$ 中的含义 |
|---|---|
| $N(A)$ | 被压到原点的输入方向：$\mathrm{span}\{(1,-1)\}$ |
| $\mathrm{Col}(A)$ | 所有可能输出的方向：$\mathrm{span}\{(1,0)\}$ |
| $\mathrm{rank}(A)$ | 「还剩几个独立输出方向」→ $1$ |
| $\mathrm{nullity}(A)$ | 「被压扁的输入方向数」→ $1$ |

**易混点：** $N(A)$ 住在**输入空间** $\mathbb{R}^n$；$\mathrm{Col}(A)$ 住在**输出空间** $\mathbb{R}^m$。二者一般不可直接比较「谁更大」，但维数由 rank-nullity 联系。
