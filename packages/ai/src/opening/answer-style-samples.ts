import type { TutorMode } from "@aistudy/contracts";

export type AnswerStyleCategory =
  | "fact"
  | "concept"
  | "derivation"
  | "comparison"
  | "process"
  | "code";

export type AnswerStyleSample = {
  id: string;
  category: AnswerStyleCategory;
  mode: TutorMode;
  question: string;
};

/** Fixed 30-sample set for opening answer-style offline evaluation. */
export const ANSWER_STYLE_SAMPLES: readonly AnswerStyleSample[] = [
  // fact (5)
  { id: "fact-01", category: "fact", mode: "hint", question: "欧拉公式 e^{i\\pi} + 1 = 0 中，虚数单位 i 的定义是什么？" },
  { id: "fact-02", category: "fact", mode: "explain", question: "HTTP 状态码 404 与 403 分别表示什么含义？" },
  { id: "fact-03", category: "fact", mode: "listen", question: "线性代数中单位矩阵的对角线元素是多少？" },
  { id: "fact-04", category: "fact", mode: "think_together", question: "TCP 三次握手的第三步客户端发送的是什么标志位？" },
  { id: "fact-05", category: "fact", mode: "explain", question: "正态分布的概率密度函数在均值处的取值公式是什么？" },

  // concept (5)
  { id: "concept-01", category: "concept", mode: "hint", question: "什么是贝叶斯定理？先验、似然与后验分别指什么？" },
  { id: "concept-02", category: "concept", mode: "explain", question: "解释大数定律与中心极限定理的区别与联系。" },
  { id: "concept-03", category: "concept", mode: "listen", question: "面向对象中的封装、继承、多态各自解决什么问题？" },
  { id: "concept-04", category: "concept", mode: "think_together", question: "什么是时间复杂度？O(n log n) 通常对应哪类算法？" },
  { id: "concept-05", category: "concept", mode: "hint", question: "梯度下降中学习率过大或过小分别会导致什么现象？" },

  // derivation (5)
  { id: "derivation-01", category: "derivation", mode: "hint", question: "推导圆的面积公式 S = \\pi r^2 的积分思路要点。" },
  { id: "derivation-02", category: "derivation", mode: "explain", question: "从二项分布推导泊松分布的极限过程需要哪些条件？" },
  { id: "derivation-03", category: "derivation", mode: "listen", question: "用数学归纳法证明 1+2+...+n = n(n+1)/2。" },
  { id: "derivation-04", category: "derivation", mode: "think_together", question: "拉格朗日乘数法求约束极值的驻点条件如何写出？" },
  { id: "derivation-05", category: "derivation", mode: "explain", question: "傅里叶变换的线性性质如何从定义直接证明？" },

  // comparison (5)
  { id: "comparison-01", category: "comparison", mode: "hint", question: "栈与队列在数据存取顺序上有何本质区别？" },
  { id: "comparison-02", category: "comparison", mode: "explain", question: "比较进程与线程：地址空间、调度开销与通信方式。" },
  { id: "comparison-03", category: "comparison", mode: "listen", question: "监督学习和无监督学习的训练数据与典型任务有何不同？" },
  { id: "comparison-04", category: "comparison", mode: "think_together", question: "B 树与红黑树分别更适呈磁盘索引还是内存结构？为什么？" },
  { id: "comparison-05", category: "comparison", mode: "hint", question: "REST 与 GraphQL 在接口粒度与过度获取问题上的取舍。" },

  // process (5)
  { id: "process-01", category: "process", mode: "hint", question: "描述快速排序一次划分（partition）的执行步骤。" },
  { id: "process-02", category: "process", mode: "explain", question: "操作系统从用户态陷入内核处理一次系统调用的大致流程。" },
  { id: "process-03", category: "process", mode: "listen", question: "用高斯消元法解三元一次方程组的步骤顺序是什么？" },
  { id: "process-04", category: "process", mode: "think_together", question: "训练一个简单神经网络时，前向传播与反向传播各做哪些事？" },
  { id: "process-05", category: "process", mode: "explain", question: "Git 中从修改工作区到完成一次本地 commit 的标准流程。" },

  // code (5)
  { id: "code-01", category: "code", mode: "hint", question: "用 Python 写一个判断回文字符串的函数，忽略大小写与空格。" },
  { id: "code-02", category: "code", mode: "explain", question: "实现二分查找，要求返回目标在有序数组中的下标或 -1。" },
  { id: "code-03", category: "code", mode: "listen", question: "用邻接表表示无向图，并写出 BFS 遍历的伪代码。" },
  { id: "code-04", category: "code", mode: "think_together", question: "写一个 TypeScript 函数，合并两个已排序数组并去重。" },
  { id: "code-05", category: "code", mode: "hint", question: "用动态规划求最长公共子序列（LCS）长度的状态转移方程。" },
];
