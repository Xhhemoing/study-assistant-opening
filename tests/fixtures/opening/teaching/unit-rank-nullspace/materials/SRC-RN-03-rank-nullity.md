# 秩—零度定理（rank-nullity）

<!-- page:1 -->

## 定理陈述

设 $A\in\mathbb{R}^{m\times n}$。则

$$
\mathrm{rank}(A)+\mathrm{nullity}(A)=n,
$$

其中 $n$ 是**列数**（输入维），$\mathrm{rank}(A)=\dim\mathrm{Col}(A)$，$\mathrm{nullity}(A)=\dim N(A)$。

直观：每个输入方向要么「贡献一个独立输出方向」（计入 rank），要么「被压到零」（计入 nullity），二者凑满全部 $n$ 个输入维。

<!-- page:2 -->

## 对几何钩子的检验

$A=\begin{bmatrix}1&1\\0&0\end{bmatrix}$，$n=2$：

- $\mathrm{rank}(A)=1$
- $\mathrm{nullity}(A)=1$
- $1+1=2=n$ ✓

## 满秩方阵情形

若 $A\in\mathbb{R}^{2\times 2}$ 可逆（例如 $A=\begin{bmatrix}2&1\\1&1\end{bmatrix}$），则 $N(A)=\{0\}$，$\mathrm{Col}(A)=\mathbb{R}^2$，故 $\mathrm{rank}=2$，$\mathrm{nullity}=0$，仍满足 $2+0=2$。

<!-- page:3 -->

## 使用注意

1. 右边是列数 $n$，不是行数 $m$。对 $A\in\mathbb{R}^{3\times 2}$，等式右边仍是 $2$。
2. 求 rank / nullity 应经行化简（RREF）数主元与自由变量，**不要**只数「对角线上非零个数」而未化简。
3. 「零特征值的代数重数 = nullity」**不是**一般定义；本单元不以特征值为准绳。
