/**
 * 生成"在用户自己电脑上下载"的 yt-dlp 命令。
 *
 * 为什么是命令而不是下载按钮：浏览器拿不到 googlevideo 的字节（响应不带 CORS 头，
 * 同源策略由浏览器执行，WASM 也绕不过），所以"点一下就从 YouTube 下原片"在纯前端
 * 不可能实现。但"下载"这件事本身可以交给用户自己的机器——不经过任何服务器，
 * 也没有第三方经手链接，这才是真正的零后端。
 *
 * 这一层只拼字符串，不发请求、不读 cookie、不碰文件系统。
 */

export const QUALITIES = {
  best: { label: "最佳画质", format: "bv*+ba/b" },
  "1080": { label: "≤ 1080p", format: "bv*[height<=1080]+ba/b[height<=1080]" },
  "720": { label: "≤ 720p", format: "bv*[height<=720]+ba/b[height<=720]" },
  audio: { label: "仅音频", audio: true },
};

export const SUBTITLE_MODES = {
  manual: "原生字幕",
  auto: "含自动生成",
  none: "不要字幕",
};

const SUB_LANGS = "zh-Hans,zh,en";

/** URL 必须是 parseYouTubeUrl 校验过的规范地址，避免把任意字符串拼进 shell 命令。 */
const SAFE_URL = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/;

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * @param {{url?: string, quality?: keyof QUALITIES, subs?: keyof SUBTITLE_MODES}} options
 * @returns {string} 可直接粘贴到终端的一行命令
 */
export function buildDownloadCommand({ url = "", quality = "best", subs = "manual" } = {}) {
  if (!url) throw new CommandError("先解析视频链接，再生成命令");
  if (!SAFE_URL.test(url)) throw new CommandError("链接格式不被接受，请用视频页地址");
  if (!QUALITIES[quality]) throw new CommandError(`未知清晰度：${quality}`);
  if (!SUBTITLE_MODES[subs]) throw new CommandError(`未知字幕模式：${subs}`);

  const parts = ["yt-dlp", "--no-playlist"];
  const target = QUALITIES[quality];

  if (target.audio) {
    parts.push("-x", "--audio-format", "m4a", "-f", '"ba/b"');
  } else {
    parts.push("-f", `"${target.format}"`, "--merge-output-format", "mp4");
  }

  if (subs === "manual") {
    parts.push("--write-subs", "--sub-langs", `"${SUB_LANGS}"`, "--convert-subs", "srt");
  } else if (subs === "auto") {
    parts.push("--write-subs", "--write-auto-subs", "--sub-langs", `"${SUB_LANGS}"`, "--convert-subs", "srt");
  }

  // %(title)s 交给 yt-dlp 自己展开，文件名里的引号由它处理；这里只负责把整串括起来
  parts.push("-o", '"%(title)s.%(ext)s"', `"${url}"`);
  return parts.join(" ");
}

/** 下载完成后该做什么——写清楚，否则用户拿到文件后不知道下一步在哪。 */
export function describeFollowUp({ subs }) {
  if (subs === "none") {
    return "下载完成后，把视频文件拖回下面的「导入本地视频 / 音频」，就能对着它校对字幕。";
  }
  return "下载完成后，把 .srt 拖回上面的「导入字幕文件」，视频拖到「导入本地视频 / 音频」——两条都不上传、不联网。";
}
