/**
 * 关键字段硬闸门
 * 缺关键字段就失败，阻止脏结果继续流转
 */

function 检查关键字段(标准镜头清单 = []) {
  const errors = [];

  for (const shot of 标准镜头清单) {
    const prefix = `[${shot.镜头编号}/${shot.镜头类型}]`;

    if (!shot.镜头时间轴) errors.push(`${prefix} 缺少【镜头时间轴】`);
    if (!Array.isArray(shot.绑定定妆照)) errors.push(`${prefix} 缺少【绑定定妆照】`);
    if (!Array.isArray(shot.人物介绍卡片)) errors.push(`${prefix} 缺少【人物介绍卡片】`);
    if (!('台词' in shot) && !('对话指令' in shot)) errors.push(`${prefix} 缺少【对话指令】或【台词】字段`);

    if (shot.镜头类型 === '片头') {
      if (!shot.主标题) errors.push(`${prefix} 缺少【主标题】`);
      if (!('副标题' in shot)) errors.push(`${prefix} 缺少【副标题】字段`);
    }
  }

  return {
    passed: errors.length === 0,
    errors
  };
}

module.exports = { 检查关键字段 };
