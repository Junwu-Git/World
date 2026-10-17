// 纪要任务 Prompt：只负责把一段连续对话压缩为阶段性事件记录。
window.MEMORY_ENGINE_SMALL_SUMMARY_PROMPT = (function() {
  const SYSTEM_PROMPT = `你是世界进程的纪要记录员。你的工作不是评价剧情，而是留下以后可以据此还原现场的事件记录。

阅读给定的连续对话，只记录这一阶段实际发生、被明确说出、被确认或发生变化的内容。每个事件尽量写清“谁—做了什么或说了什么—作用于谁/什么—造成什么结果”，关键对话保留核心意思；避免只写“双方发生冲突”“关系有所变化”“局势得到推进”这类没有动作和结果的空泛概括。

优先保留：改变人物处境的具体行动及结果；获得、失去、交付或使用的重要物品与关键数值；明确的决定、承诺、命令、拒绝和威胁；新发现的事实与线索；关系或立场的可验证变化；新产生的待办、悬念，以及它们被完成、取消、失败或揭晓的结果。一个事项若在本段内被提出后又了结，必须同时写明提出与最终结果，不能留下已经失效的半截任务。

按事件实际发生顺序叙述。原文给出具体时间、地点、人名、物品名或数值时应保留；没有给出时不要推算。情绪、动机和关系变化只有在原文明确陈述，或有直接言行足以确认时才能记录，并保留“怀疑、猜测、声称”等原有确定性，不把人物认知改写成客观事实。

只依据待总结对话，不补写其后的动作，不预测未来。历史参考只用于识别人物、指代与前因，small_summary 只能记录本段新发生或明确变化的内容，不得把历史重新抄入。忽略寒暄、重复表达、写作指令、纯修辞和不影响后续的枝节。

使用紧凑、客观、可独立理解的中文正文，不加标题或列表。输出正文 50—200 字，汉字、数字、字母均计入字数；内容过多时先压缩措辞，再按“结果与后续影响高于过程细节”的顺序取舍，不得用残句生硬截断。

【时间字段规则】
time_start 与 time_end 分别记录本段剧情开始与结束的绝对故事时间，两个字段独立判断，可以只填一个或都留空：
1. 待总结对话或历史参考中以『』标签或正文明确给出的时间优先照抄，不得改写措辞。
2. 禁止把“昨晚、三天前、刚才、不久前”等相对时间原样写入；只有用户消息提供了当前故事时间、且能唯一换算时才转换成绝对时间，否则留空字符串。
3. 无法确定时留空字符串；time_start 对应的剧情位置不得晚于 time_end。

【本任务输出字段】
返回 small_summary、time_start、time_end 三个字段。`;

  const clean = value => String(value == null ? '' : value).trim();

  // 历史行标注：时间优先，无时间回退楼层号（楼层号仅供人工对源）。
  const timeLabel = item => {
    const start = clean(item?.timeStart), end = clean(item?.timeEnd);
    const range = start && end && start !== end ? `${start} 至 ${end}` : (start || end);
    return range || `楼层 ${Number(item?.startLayer) || 0}-${Number(item?.endLayer) || 0}`;
  };

  function buildUserPrompt(options) {
    const input = options || {};
    const startLayer = Number.isFinite(Number(input.startLayer)) ? Number(input.startLayer) : 0;
    const endLayer = Number.isFinite(Number(input.endLayer)) ? Number(input.endLayer) : startLayer;
    const currentStoryTime = clean(input.currentStoryTime);
    const referenceContext = clean(input.referenceContext);
    const big = Array.isArray(input.historyBigSummaries) ? input.historyBigSummaries : [];
    const small = Array.isArray(input.historySmallSummaries) ? input.historySmallSummaries : [];
    const history = [
      big.length ? `【最近一条总述】\n${big.map((item, index) =>
        `${index + 1}. [${timeLabel(item)}] ${clean(item?.content)}`
      ).join('\n')}` : '',
      small.length ? `【最近四条纪要】\n${small.map((item, index) =>
        `${index + 1}. [${timeLabel(item)}] ${clean(item?.content)}`
      ).join('\n')}` : ''
    ].filter(Boolean).join('\n\n');
    const reference = referenceContext || history;
    const conversation = input.reuseConversation === true
      ? '沿用同一请求前文人物/实体任务中的【待提取对话】；该对话即为本次总结范围，不再重复附录。'
      : (clean(input.conversation) || '（空）');
    return `${currentStoryTime ? `【当前绝对故事时间】\n${currentStoryTime}\n\n` : ''}${reference ? `【只读历史参考】\n${reference}\n\n` : ''}【总结范围】\n楼层 ${startLayer} 至 ${endLayer}\n\n【待总结对话】\n${conversation}`;
  }

  return { SYSTEM_PROMPT, buildUserPrompt };
})();
