/**
 * Study simulation: what a careful AI teacher writes for each page of the Math I
 * Unit 8 slides (inverse/implicit functions, extrema, Lagrange multipliers).
 * The simulation answers the compile prompt with these instead of a live model,
 * so the program's own planning — not a model — decides what is taught when.
 */
export type PageLesson = {
  page: number;
  /** Section heading on the slide (the material's own structure). */
  heading: string;
  section: "overview" | "8.1" | "8.2" | "8.3";
  type: "text" | "example" | "steps";
  text: string;
  /** Verbatim from the slide (checked against the chunk by the compiler). */
  quote?: string;
  question?: { prompt: string; answer: string };
};

export const UNIT8_PAGES: PageLesson[] = [
  { page: 1, heading: "Inverse, implicit functions and calculus of extrema", section: "overview", type: "text",
    text: "本单元：反函数与隐函数（inverse / implicit functions）以及多元函数的极值（calculus of extrema）。" },
  { page: 2, heading: "Objectives", section: "overview", type: "text",
    text: "学习目标：理解多元反函数定理与隐函数定理；求无约束数量场的局部极值；用拉格朗日乘数（Lagrange multipliers）求条件极值与最值。三节：8.1 反函数与隐函数定理，8.2 数量场的局部极值，8.3 拉格朗日乘数与绝对极值。",
    quote: "Lagrange multipliers and absolute extrema." },
  { page: 3, heading: "Jacobian", section: "8.1", type: "example",
    text: "雅可比行列式（Jacobian）：$f:U\\subset\\mathbb R^n\\to\\mathbb R^n$ 在 $u$ 可微时，$J_f(u)=\\det(df(u))$。例：$f(x,y)=(x-y^2,\\,x^2+2y)$，微分矩阵为 $\\begin{pmatrix}1&-2y\\\\2x&2\\end{pmatrix}$，所以 $J_f=2+4xy$。",
    quote: "is called the Jacobian of f at u",
    question: { prompt: "求 $f(x,y)=(x+y,\\;xy)$ 的雅可比行列式，并指出它在哪些点为 0。", answer: "$df=\\begin{pmatrix}1&1\\\\y&x\\end{pmatrix}$，$J_f=x-y$；在直线 $x=y$ 上为 0。" } },
  { page: 4, heading: "Inverse Function Theorem", section: "8.1", type: "text",
    text: "反函数定理（Inverse Function Theorem）：$f$ 是 $C^1$ 且 $J_f(u)\\ne0$，则在 $u$ 附近 $f$ 局部可逆，逆映射也是 $C^1$，且 $df^{-1}(f(v))=(df(v))^{-1}$。注意它只给出“局部”可逆。",
    quote: "is bijective",
    question: { prompt: "$f(x,y)=(e^x\\cos y,\\;e^x\\sin y)$ 在每一点都局部可逆吗？它是整体单射吗？", answer: "$J_f=e^{2x}>0$，处处局部可逆；但 $f(x,y)=f(x,y+2\\pi)$，不是整体单射。" } },
  { page: 5, heading: "Implicit Function Theorem (motivation)", section: "8.1", type: "example",
    text: "隐函数的动机：单位球面 $x^2+y^2+z^2=1$ 在 $z_0>0$ 附近可写成 $z=\\sqrt{1-x^2-y^2}$，于是 $z_x=-x/z,\\ z_y=-y/z$。隐函数定理让我们不必先解出 $z$ 就能求这些偏导，这叫隐函数求导（implicit differentiation）。",
    quote: "This procedure is known as implicit differentiation." },
  { page: 6, heading: "Implicit Function Theorem", section: "8.1", type: "text",
    text: "隐函数定理（Implicit Function Theorem）：$f(u)=0$ 且 $D_nf(u)\\ne0$ 时，在 $u$ 附近零点集是一个 $C^1$ 函数 $u_n=g(u_1,\\dots,u_{n-1})$ 的图像，并且 $D_jg=-D_jf/D_nf$。",
    quote: "and a function g",
    question: { prompt: "由 $x^2+y^2+z^2=1$ 在点 $(0,0,1)$ 附近确定 $z=z(x,y)$，用隐函数定理求 $\\partial z/\\partial x$。", answer: "$F=x^2+y^2+z^2-1$，$F_z=2z\\ne0$，$z_x=-F_x/F_z=-x/z$，在 $(0,0,1)$ 处为 0。" } },
  { page: 7, heading: "Second-order partial derivatives", section: "8.1", type: "example",
    text: "二阶偏导（second-order partial derivatives）：$D_{ij}f=D_i(D_jf)$。例：$f=3x^3-y^2+5$，$D_1f=9x^2$，$D_2f=-2y$，$D_{11}f=18x$，$D_{12}f=D_{21}f=0$，$D_{22}f=-2$。",
    quote: "Higher-order partial derivatives are defined analogously.",
    question: { prompt: "求 $f(x,y)=x^2y+\\sin y$ 的全部二阶偏导。", answer: "$f_x=2xy$，$f_y=x^2+\\cos y$；$f_{xx}=2y$，$f_{xy}=f_{yx}=2x$，$f_{yy}=-\\sin y$。" } },
  { page: 8, heading: "Mixed partial derivatives", section: "8.1", type: "text",
    text: "混合偏导的次序一般不能交换。Peano 的反例说明二阶偏导在 $(0,0)$ 都存在，但 $D_{12}f(0,0)\\ne D_{21}f(0,0)$。",
    quote: "The order matters." },
  { page: 9, heading: "Schwarz–Young Theorem", section: "8.1", type: "text",
    text: "Schwarz–Young 定理：若 $D_if$、$D_jf$ 在 $a$ 的邻域存在且在 $a$ 可微，则 $D_{ij}f(a)=D_{ji}f(a)$。常用的充分情形：$f\\in C^2$。",
    quote: "Schwarz–Young Theorem",
    question: { prompt: "为什么 $C^2$ 函数的 Hessian 矩阵是对称的？", answer: "$C^2$ 时一阶偏导可微，由 Schwarz–Young 定理 $D_{ij}f=D_{ji}f$，所以 $H_f$ 对称。" } },
  { page: 10, heading: "Local Extrema", section: "8.2", type: "text",
    text: "局部极值（relative extrema）的定义，以及费马定理（Fermat's Theorem）：在内点取得极值且偏导存在，则 $\\nabla f(x_0)=0$。",
    quote: "attains a relative extremum at an interior",
    question: { prompt: "$f(x,y)=x^2+y^2$ 在 $(0,0)$ 取极小值，验证费马定理的结论。", answer: "$\\nabla f=(2x,2y)$，在 $(0,0)$ 为 $(0,0)$，与定理一致。" } },
  { page: 11, heading: "Proof of Fermat's Theorem", section: "8.2", type: "steps",
    text: "证明思路：\n在极大值点，$t\\to0^+$ 时差商 $\\le0$\n$t\\to0^-$ 时差商 $\\ge0$\n两个单侧极限相等，只能为 0",
    quote: "Hence the only possibility is" },
  { page: 12, heading: "Locating Relative Extrema", section: "8.2", type: "text",
    text: "费马定理只给出“候选点”：切平面水平（偏导全为 0）的点是极值的候选。",
    quote: "will be the candidates for relative extrema." },
  { page: 13, heading: "Limitations of the Criterion", section: "8.2", type: "text",
    text: "判别法的局限：梯度为 0 不一定是极值（$x^2-y^2$ 在原点）；极值点可能没有偏导（$\\sqrt{x^2+y^2}$）；边界点不适用费马定理（正方形上的 $2-x^2-y^2$ 在顶点取最小）。",
    quote: "The theorem only applies to interior points.",
    question: { prompt: "$f(x,y)=\\sqrt{x^2+y^2}$ 在原点有极小值，为什么费马定理找不到它？", answer: "该点偏导不存在，费马定理的前提不满足；求候选点时还要检查不可微点和边界点。" } },
  { page: 14, heading: "Critical Points, Saddle Points", section: "8.2", type: "text",
    text: "临界点（critical point）：内点且 $\\nabla f(x_0)=0$。既不是极大也不是极小的临界点叫鞍点（saddle point）。",
    quote: "is called a saddle point." },
  { page: 15, heading: "Hessian Matrix", section: "8.2", type: "text",
    text: "Hessian 矩阵 $H_f(x_0)=[D_{ij}f(x_0)]$，$C^2$ 时对称。顺序主子式（leading principal minors）$\\Delta_k$ 是左上 $k\\times k$ 子矩阵的行列式。",
    quote: "the matrix Hf is symmetric." },
  { page: 16, heading: "Classification Theorem", section: "8.2", type: "text",
    text: "分类定理：全部 $\\Delta_k>0$ → 极小；$(-1)^k\\Delta_k>0$ → 极大；$\\Delta_n\\ne0$ 且不属于前两种 → 鞍点。二元情形：$\\Delta>0,f_{xx}>0$ 极小；$\\Delta>0,f_{xx}<0$ 极大；$\\Delta<0$ 鞍点；$\\Delta=0$ 无结论。",
    quote: "This criterion yields no information if",
    question: { prompt: "求 $f(x,y)=x^3-3x+y^2$ 的临界点并分类。", answer: "$\\nabla f=(3x^2-3,2y)=0$ 得 $(1,0),(-1,0)$。$H=\\mathrm{diag}(6x,2)$：$(1,0)$ 处 $\\Delta=12>0,f_{xx}=6>0$ 为极小；$(-1,0)$ 处 $\\Delta=-12<0$ 为鞍点。" } },
  { page: 17, heading: "Example: e^{1-x^2-y^2}", section: "8.2", type: "example",
    text: "例：$f=e^{1-x^2-y^2}$，唯一临界点 $(0,0)$，$H_f(0,0)=\\mathrm{diag}(-2,-2)$，$\\Delta=4>0$ 且 $f_{xx}=-2<0$，所以是极大值点，$f(0,0)=e$。",
    quote: "we obtain a single critical point" },
  { page: 18, heading: "Lagrange Multipliers (motivation)", section: "8.3", type: "text",
    text: "条件极值的动机：在约束 $\\Phi(x,y)=0$ 下求 $f$ 的极值。若能解出 $y=g(x)$，就化成一元函数 $h(x)=f(x,g(x))$ 的极值问题。",
    quote: "subject to the constraint" },
  { page: 19, heading: "Lagrange Multipliers (derivation)", section: "8.3", type: "text",
    text: "由 $h'(a)=0$ 和对约束求导可知 $\\nabla f(a,b)$ 与 $\\nabla\\Phi(a,b)$ 线性相关，于是 $\\nabla f=\\lambda\\nabla\\Phi$（拉格朗日乘数 $\\lambda$）。",
    quote: "are linearly dependent vectors",
    question: { prompt: "在 $x+y=1$ 上求 $f(x,y)=xy$ 的极值点。", answer: "$\\nabla f=(y,x)=\\lambda(1,1)$ 得 $x=y=1/2$，$f=1/4$，为极大值。" } },
  { page: 20, heading: "Lagrange Multipliers (theorem)", section: "8.3", type: "text",
    text: "一般形式：$k<n$ 个约束 $\\Phi_i=0$，梯度 $\\nabla\\Phi_1,\\dots,\\nabla\\Phi_k$ 线性无关时，条件极值点满足 $\\nabla f(u_0)=\\sum\\lambda_i\\nabla\\Phi_i(u_0)$。",
    quote: "are linearly independent vectors for all" },
  { page: 21, heading: "Example: absolute extrema on M", section: "8.3", type: "example",
    text: "例：$f=xy+xz$ 在平面 $y+z=1$ 与单位球面的交线上。解方程组得 $p_{1,2}=(\\pm1/\\sqrt2,1/2,1/2)$，$f(p_{1,2})=\\pm1/\\sqrt2$。$M$ 是紧集，由 Weierstrass 定理最值必在候选点中取到。",
    quote: "the extrema are attained on the compact set",
    question: { prompt: "在单位圆 $x^2+y^2=1$ 上求 $f(x,y)=x+y$ 的最大值与最小值。", answer: "$(1,1)=\\lambda(2x,2y)$ 得 $x=y=\\pm1/\\sqrt2$，最大值 $\\sqrt2$，最小值 $-\\sqrt2$（圆是紧集，最值存在）。" } },
];
