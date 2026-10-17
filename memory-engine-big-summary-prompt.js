// 总述任务 Prompt：只整理本批尚未归档的纪要，不读取或改写历史总述。
window.MEMORY_ENGINE_BIG_SUMMARY_PROMPT = (function() {
  const SYSTEM_PROMPT = `你是世界进程的总述编纂者。你要把一组按时间排列的纪要编成一段可以脱离原文独立使用的阶段史，而不是再列一遍纪要，也不是写主题评论。

先在内部辨认本阶段的主线、支线和转折，再按实际先后把事件串联起来。写清关键行动如何引出后果、人物为何改变目标或立场、冲突如何升级或收束，以及发现、决定、承诺和损失怎样影响后续。允许合并重复信息和压缩过渡过程，但不得把具体事件抽象成“局势变化”“关系加深”“经历了一系列事件”等空壳句。

必须保留：决定阶段走向的行动与结果；关键人物的目标、阵营、关系和处境变化；重大冲突及其结局；重要发现、物品、地点与关键数值；持续有效的约定、任务、威胁与悬念；已经完成、取消、失败、作废或揭晓的事项。事项的建立与了结具有同等重要性，禁止只保留建立而遗漏结局，导致已结束的线索看起来仍然悬而未决。

时间、地点和因果关系只能来自输入纪要。原文确定到什么程度就写到什么程度，不自行补日期、动机或隐藏联系；人物的怀疑、误解、谎言和主张仍按人物认知表述，不能升级成世界事实。只依据输入，不补写未发生的情节，不预测未来。

成文应像一篇冷静、密实的阶段纪事：以连贯段落组织，不使用标题、列表、点评或元叙事；在信息不丢失的前提下合并同类事件，保留足以让后续模型准确续接剧情的具体人物、动作、对象与结果。

严格遵守用户消息给出的【本次篇幅】：正文至少 500 字，最多不超过本批全部纪要正文总字数的一半；若计算所得的一半少于 500 字，则本次上下限都按 500 字执行。汉字、数字、字母均计入字数。先组织完整内容再输出，不得靠重复、空话凑字，也不得生硬截断。

【时间字段规则】
time_start 与 time_end 分别记录本阶段的起止绝对故事时间，只能来自输入条目自带的时间标注（含各条目的起止时间），不得自行补日期或推算；输入条目都没有时间时两个字段都留空字符串。

【本任务输出字段】
返回 big_summary、time_start、time_end 三个字段。`;

  const clean = value => String(value == null ? '' : value).trim();

  // 输入行标注：时间优先，无时间回退楼层号。
  const timeLabel = item => {
    const start = clean(item?.timeStart), end = clean(item?.timeEnd);
    const range = start && end && start !== end ? `${start} 至 ${end}` : (start || end);
    return range || `楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}`;
  };

  function buildUserPrompt(options) {
    const input = options || {};
    // level ≥ 2：输入是既有总述而非原始纪要，要求合并成更高一层的总览。
    const isMeta = Number(input.level) >= 2;
    const records = Array.isArray(input.summaries) ? input.summaries : [];
    const sourceLength = records.reduce((total, item) => total + clean(item?.content).length, 0);
    const maxLength = Math.max(500, Math.ceil(sourceLength / 2));
    const inputHeader = isMeta ? '【待合并的既有总述】' : '【待整理的阶段纪要】';
    const metaNote = isMeta
      ? '\n\n本次输入是既有总述而非原始纪要：按同样的规则把它们合并成更早期的总览，只压缩与重组输入内容，不得虚构输入之外的细节。'
      : '';
    return `【本次篇幅】\n总述正文不少于 500 字、不超过 ${maxLength} 字。\n\n${inputHeader}\n${records.length ? records.map((item, index) =>
      `${index + 1}. [${timeLabel(item)}] ${clean(item?.content)}`
    ).join('\n') : '（暂无）'}${metaNote}`;
  }

  return { SYSTEM_PROMPT, buildUserPrompt };
})();
