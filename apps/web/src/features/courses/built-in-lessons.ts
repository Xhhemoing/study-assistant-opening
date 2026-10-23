/** 内置的现成课只属于线性代数；只有课程名称/简介/标识看得出是这一学科时才推荐，避免非数学课程看到无关内容。 */
export type BuiltInLesson = { id: "span" | "matrix"; label: string; href: string };

const LINEAR_ALGEBRA = /线性代数|线代|线性组合|线性空间|向量空间|矩阵|行列式|特征值|span|linear\s*algebra|matri(x|ces)|vector\s*space|eigen/i;

export function courseMatchesLinearAlgebra(course: { title?: string | null; description?: string | null; slug?: string | null } | null | undefined): boolean {
  if (!course) return false;
  return LINEAR_ALGEBRA.test([course.title, course.description, course.slug].filter(Boolean).join(" "));
}

export function builtInLessonsForCourse(courseId: string, course: Parameters<typeof courseMatchesLinearAlgebra>[0]): BuiltInLesson[] {
  if (!courseMatchesLinearAlgebra(course)) return [];
  const base = `/opening/courses/${encodeURIComponent(courseId)}/study`;
  return [
    { id: "span", label: "线性组合与 span", href: `${base}/span` },
    { id: "matrix", label: "矩阵怎样变换平面向量", href: `${base}/matrix` },
  ];
}
