/**
 * 翻译提示词构造。
 *
 * 单独成模块的唯一原因：测试要能直接拿到"真实用于请求的 prompt"，
 * 而不是在测试里复制一份近似品——复制品会漂移，测了等于没测。
 */

const SEGMENT_BREAK = "\n\n\n";

export function buildTranslationPrompt({ segmentText, targetLanguage, contextText = "", instruction = "" }) {
  const head = contextText ? `参考资料：\n${contextText}\n\n` : "";
  // 额外要求里的连续空行会干扰下面的边界提取，先压平
  const extra = String(instruction || "").replace(/\n{3,}/g, "\n\n").trim();
  const requirements = extra ? `\n\n额外要求（与上面的规则冲突时以用户要求为准）：\n${extra}` : "";
  return (
    `${head}请把下面的字幕翻译成${targetLanguage}。` +
    `必须保持字幕条目数量、序号与时间轴完全一致，只能改写每条字幕的文本内容。${requirements}` +
    // 用三连换行分隔说明与正文：SRT 条目之间最多两个换行，不会撞车
    `${SEGMENT_BREAK}${segmentText}`
  );
}

/** 从完整 prompt 里切回"待翻译字幕"部分，供本地假模型与调试使用。 */
export function extractSegment(prompt) {
  const index = String(prompt).lastIndexOf(SEGMENT_BREAK);
  return index === -1 ? String(prompt) : String(prompt).slice(index + SEGMENT_BREAK.length);
}
