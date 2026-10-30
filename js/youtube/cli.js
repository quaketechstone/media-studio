/**
 * 生成"在用户自己电脑上只下载字幕"的 yt-dlp 命令。
 *
 * 为什么是命令而不是下载按钮：浏览器拿不到 YouTube 的字幕字节。
 * `timedtext` 端点不带 CORS 头，2023 年起还要求 PO token，同源策略由浏览器执行，
 * WASM 也没有独立网络栈。所以"点一下就从 YouTube 拿到字幕文件"在纯前端不可能，
 * 这也是本项目保留执行器通道的原因。
 *
 * 但"下载"这件事可以交给用户自己的机器：不经过任何服务器，也没有第三方经手链接。
 * 而且**只下载字幕**是整个链路里最轻的一种——不需要 ffmpeg、
 * 不需要合并音视频轨、几十 KB 几秒钟完成。这是真正的零后端路径。
 *
 * 这一层只拼字符串，不发请求、不读 cookie、不碰文件系统。
 */

/** 取哪些轨道。`auto` 在原生字幕缺失时才有用，默认不开，避免抓到质量差的自动字幕。 */
export const SUBTITLE_SCOPES = {
  manual: { label: "只要原生字幕", flag: "--write-subs" },
  auto: { label: "原生优先，没有就用自动生成", flag: "--write-subs --write-auto-subs" },
  all: { label: "全部语言（含自动生成）", flag: "--write-subs --write-auto-subs", langs: "all" },
};

/**
 * 落盘格式。
 * `vtt` 是 yt-dlp 的原样保存，**不需要 ffmpeg**；
 * `srt` 要过 ffmpeg 做一次容器转换，下文会如实提示。
 */
export const SUBTITLE_FORMATS = {
  vtt: { label: "VTT（原样，不需要 ffmpeg）", needsFfmpeg: false },
  srt: { label: "SRT（需要 ffmpeg 转换）", needsFfmpeg: true },
};

export const DEFAULT_LANGS = "zh-Hans,zh,en";

/** URL 必须是 parseYouTubeUrl 校验过的规范地址，避免把任意字符串拼进 shell 命令。 */
const SAFE_URL = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/;

/** 语言列表只允许"语言码、连字符、逗号、星号"，其它字符一律拒绝——它会被拼进命令。 */
const SAFE_LANGS = /^[A-Za-z0-9,\-_*]{1,200}$/;

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * @param {{url?: string, scope?: keyof SUBTITLE_SCOPES, langs?: string, format?: keyof SUBTITLE_FORMATS}} options
 * @returns {{command: string, needsFfmpeg: boolean}} 可直接粘贴到终端的一行命令
 */
export function buildSubtitleCommand({
  url = "",
  scope = "manual",
  langs = DEFAULT_LANGS,
  format = "vtt",
} = {}) {
  if (!url) throw new CommandError("先解析视频链接，再生成命令");
  if (!SAFE_URL.test(url)) throw new CommandError("链接格式不被接受，请用视频页地址");
  const pickedScope = SUBTITLE_SCOPES[scope];
  if (!pickedScope) throw new CommandError(`未知字幕范围：${scope}`);
  const pickedFormat = SUBTITLE_FORMATS[format];
  if (!pickedFormat) throw new CommandError(`未知字幕格式：${format}`);

  const wanted = String(langs || DEFAULT_LANGS).trim();
  if (!SAFE_LANGS.test(wanted)) {
    throw new CommandError("语言列表只能包含语言码、逗号与连字符");
  }

  const parts = ["yt-dlp", "--no-playlist", "--skip-download"];
  parts.push(...pickedScope.flag.split(" "));
  // allLang 场景统一用 all，用户填的列表在普通场景生效
  parts.push("--sub-langs", `"${pickedScope.langs || wanted}"`);
  if (format === "srt") parts.push("--convert-subs", "srt");

  // %(title)s 交给 yt-dlp 自己展开，文件名里的引号由它处理；这里只负责把整串括起来
  parts.push("-o", '"%(title)s.%(ext)s"', `"${url}"`);
  return { command: parts.join(" "), needsFfmpeg: pickedFormat.needsFfmpeg };
}

/**
 * 命令执行完之后该做什么——写清楚，否则用户拿到文件后不知道下一步在哪。
 * 需要 ffmpeg 这件事必须提前说，不能等命令跑失败了才让人去查。
 */
export function describeCommandResult({ format } = {}) {
  const picked = SUBTITLE_FORMATS[format] || SUBTITLE_FORMATS.vtt;
  const tail = "完成后把字幕拖回上面的「导入字幕文件」，或直接用它校对已有视频——文件不上传、不联网。";
  if (picked.needsFfmpeg) {
    return `这条命令会用 ffmpeg 把字幕转成 .srt，请先确认本机已安装（brew install ffmpeg / apt install ffmpeg）。${tail}`;
  }
  return `这条命令只保存原始字幕，不需要 ffmpeg 也不需要合并轨道。${tail}`;
}
