/**
 * 翻译提示词构造。
 *
 * 单独成模块的唯一原因：测试要能直接拿到"真实用于请求的 prompt"，
 * 而不是在测试里复制一份近似品——复制品会漂移，测了等于没测。
 */
export function buildTranslationPrompt({ segmentText, targetLanguage, contextText = "" }) {
  const head = contextText ? `参考资料：\n${contextText}\n\n` : "";
  return (
    `${head}请把下面的字幕翻译成${targetLanguage}。` +
    `必须保持字幕条目数量、序号与时间轴完全一致，只能改写每条字幕的文本内容。\n\n${segmentText}`
  );
}

/** 从完整 prompt 里切回"待翻译字幕"部分，供本地假模型与调试使用。 */
export function extractSegment(prompt) {
  const marker = "只能改写每条字幕的文本内容。\n\n";
  const index = prompt.lastIndexOf(marker);
  return index === -1 ? prompt : prompt.slice(index + marker.length);
}
