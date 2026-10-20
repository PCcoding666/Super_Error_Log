/** Initial junior catalog; independent of textbook editions. Keys never depend on display names. */
export const JUNIOR_CATALOG_VERSION = 1;

interface TopicSeed {
  key: string;
  name: string;
  aliases?: readonly string[];
}

interface SubjectSeed {
  key: string;
  name: string;
  topics: readonly TopicSeed[];
}

export const JUNIOR_CATALOG: readonly SubjectSeed[] = [
  {
    key: 'math', name: '数学', topics: [
      { key: 'rational-numbers', name: '有理数', aliases: ['有理数运算'] },
      { key: 'real-numbers', name: '实数', aliases: ['平方根与立方根'] },
      { key: 'algebraic-expressions', name: '整式及其运算', aliases: ['整式运算'] },
      { key: 'factorization', name: '因式分解' },
      { key: 'fractions', name: '分式及其运算', aliases: ['分式运算'] },
      { key: 'quadratic-radicals', name: '二次根式' },
      { key: 'linear-equations', name: '一元一次方程' },
      { key: 'linear-systems', name: '二元一次方程组' },
      { key: 'inequalities', name: '一元一次不等式与不等式组', aliases: ['不等式组', '一元一次不等式'] },
      { key: 'quadratic-equations', name: '一元二次方程' },
      { key: 'quadratic-discriminant', name: '根的判别式' },
      { key: 'fractional-equations', name: '分式方程' },
      { key: 'coordinates', name: '平面直角坐标系' },
      { key: 'direct-proportion', name: '正比例函数' },
      { key: 'linear-functions', name: '一次函数' },
      { key: 'inverse-proportion', name: '反比例函数' },
      { key: 'quadratic-functions', name: '二次函数' },
      { key: 'lines-and-angles', name: '相交线与平行线', aliases: ['平行线的性质与判定'] },
      { key: 'triangles', name: '三角形' },
      { key: 'congruent-triangles', name: '全等三角形' },
      { key: 'isosceles-triangles', name: '等腰三角形' },
      { key: 'pythagorean-theorem', name: '勾股定理', aliases: ['勾股定理应用'] },
      { key: 'similar-triangles', name: '相似三角形' },
      { key: 'parallelograms', name: '平行四边形' },
      { key: 'special-quadrilaterals', name: '矩形菱形与正方形' },
      { key: 'circles', name: '圆', aliases: ['圆的性质'] },
      { key: 'tangents', name: '圆的切线' },
      { key: 'trigonometry', name: '锐角三角函数', aliases: ['解直角三角形'] },
      { key: 'transformations', name: '平移旋转与轴对称' },
      { key: 'projections', name: '投影与视图' },
      { key: 'statistics', name: '统计', aliases: ['数据的收集与分析'] },
      { key: 'probability', name: '概率' },
    ],
  },
  {
    key: 'physics', name: '物理', topics: [
      { key: 'motion', name: '机械运动', aliases: ['速度计算'] },
      { key: 'sound', name: '声现象' },
      { key: 'light-reflection', name: '光的反射', aliases: ['平面镜成像'] },
      { key: 'light-refraction', name: '光的折射' },
      { key: 'lenses', name: '透镜及其应用', aliases: ['凸透镜成像'] },
      { key: 'phase-changes', name: '物态变化' },
      { key: 'mass-density', name: '质量与密度' },
      { key: 'forces', name: '力与受力分析', aliases: ['受力分析'] },
      { key: 'gravity', name: '重力' },
      { key: 'elasticity', name: '弹力' },
      { key: 'friction', name: '摩擦力' },
      { key: 'newton-first-law', name: '牛顿第一定律', aliases: ['惯性'] },
      { key: 'balanced-forces', name: '二力平衡' },
      { key: 'pressure', name: '压强' },
      { key: 'fluid-pressure', name: '液体与气体压强', aliases: ['大气压强'] },
      { key: 'buoyancy', name: '浮力', aliases: ['阿基米德原理'] },
      { key: 'work-power', name: '功与功率' },
      { key: 'mechanical-energy', name: '机械能', aliases: ['动能与势能'] },
      { key: 'simple-machines', name: '简单机械', aliases: ['杠杆与滑轮'] },
      { key: 'mechanical-efficiency', name: '机械效率' },
      { key: 'internal-energy', name: '内能与热量', aliases: ['比热容'] },
      { key: 'circuits', name: '电路与电流' },
      { key: 'voltage-resistance', name: '电压与电阻' },
      { key: 'series-parallel', name: '串并联电路' },
      { key: 'ohms-law', name: '欧姆定律' },
      { key: 'electrical-power', name: '电功与电功率' },
      { key: 'joules-law', name: '焦耳定律' },
      { key: 'electrical-safety', name: '生活用电', aliases: ['安全用电'] },
      { key: 'electromagnetism', name: '电与磁', aliases: ['电磁现象'] },
      { key: 'energy', name: '能源与能量转化' },
    ],
  },
  {
    key: 'chemistry', name: '化学', topics: [
      { key: 'laboratory-basics', name: '化学实验基本操作' },
      { key: 'air-oxygen', name: '空气与氧气' },
      { key: 'particles', name: '分子原子与离子' },
      { key: 'elements', name: '元素与元素符号' },
      { key: 'chemical-formula', name: '化学式与化合价' },
      { key: 'substance-types', name: '物质的分类', aliases: ['单质与化合物'] },
      { key: 'water', name: '水与水的净化' },
      { key: 'mass-conservation', name: '质量守恒定律' },
      { key: 'chemical-equations', name: '化学方程式', aliases: ['化学方程式配平'] },
      { key: 'chemical-calculations', name: '化学方程式计算' },
      { key: 'carbon', name: '碳及其化合物' },
      { key: 'carbon-dioxide', name: '二氧化碳的性质与制取' },
      { key: 'combustion', name: '燃烧与灭火' },
      { key: 'fuels', name: '燃料及其利用' },
      { key: 'metals', name: '金属材料与金属活动性', aliases: ['金属活动性顺序'] },
      { key: 'corrosion', name: '金属的冶炼与防护' },
      { key: 'solutions', name: '溶液与溶解度', aliases: ['饱和溶液与不饱和溶液'] },
      { key: 'mass-fraction', name: '溶质质量分数' },
      { key: 'acids-bases', name: '酸和碱' },
      { key: 'ph-neutralization', name: '酸碱度与中和反应', aliases: ['pH与中和反应'] },
      { key: 'salts-fertilizers', name: '盐与化肥' },
      { key: 'reaction-types', name: '基本反应类型' },
      { key: 'gas-preparation', name: '气体的制取与检验' },
      { key: 'identification', name: '物质的检验与除杂' },
      { key: 'health-materials', name: '化学与健康及材料' },
    ],
  },
];
