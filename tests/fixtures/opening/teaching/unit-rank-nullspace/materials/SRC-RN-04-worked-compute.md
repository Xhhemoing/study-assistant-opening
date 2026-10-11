# 计算示范：求 $N(A)$、rank 与 nullity

<!-- page:1 -->

## 例 1：几何钩子矩阵

$$
A=\begin{bmatrix}1&1\\0&0\end{bmatrix}.
$$

已是 RREF。主元列：第 1 列 → $\mathrm{rank}(A)=1$。  
自由变量：$x_2=t$。由 $x_1+x_2=0$ 得 $x_1=-t$，故

$$
N(A)=\mathrm{span}\left\{\begin{pmatrix}-1\\1\end{pmatrix}\right\}
=\mathrm{span}\left\{\begin{pmatrix}1\\-1\end{pmatrix}\right\},
\quad \mathrm{nullity}(A)=1.
$$

（基向量差一个非零倍数视为同一答案。）

<!-- page:2 -->

## 例 2：$3\times 3$ 有自由变量

$$
B=\begin{bmatrix}1&2&3\\2&4&6\\0&1&1\end{bmatrix}.
$$

行变换：$R_2\leftarrow R_2-2R_1$ 得

$$
\begin{bmatrix}1&2&3\\0&0&0\\0&1&1\end{bmatrix},
$$

再交换 $R_2\leftrightarrow R_3$，并 $R_1\leftarrow R_1-2R_2$：

$$
\begin{bmatrix}1&0&1\\0&1&1\\0&0&0\end{bmatrix}\quad\text{（RREF）}.
$$

主元列：第 1、2 列 → $\mathrm{rank}(B)=2$。  
自由变量：$x_3=s$。则 $x_1=-s$，$x_2=-s$，故

$$
N(B)=\mathrm{span}\left\{\begin{pmatrix}-1\\-1\\1\end{pmatrix}\right\},
\quad \mathrm{nullity}(B)=1.
$$

检验：$2+1=3=n$ ✓。

<!-- page:3 -->

## 例 3：满秩 $2\times 2$

$$
C=\begin{bmatrix}2&1\\1&1\end{bmatrix}.
$$

$\det(C)=2-1=1\neq 0$，故可逆，$N(C)=\{0\}$，$\mathrm{rank}(C)=2$，$\mathrm{nullity}(C)=0$。  
RREF 为 $I_2$。$\mathrm{Col}(C)=\mathbb{R}^2$。

## 计算清单（教学用）

1. 写出增广矩阵 $[A\mid 0]$ 或直接对 $A$ 做行化简。  
2. 数主元 → rank；数自由变量 → nullity。  
3. 用参数写出通解 → 给出 $N(A)$ 的一组基。  
4. 用 rank-nullity 做维数核对。
