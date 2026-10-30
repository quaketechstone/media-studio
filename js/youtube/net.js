/**
 * 网络相关的小工具。单独成文件是为了避免两个客户端各写一份，
 * 也避免它们互相 import 形成耦合。
 */

/**
 * 合并"用户取消"与"超时"两个信号。
 * 不做超时的话，执行器卡住时 UI 会无限转圈——比报错更难排查。
 */
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(ms) : null;
  if (!timeout) return signal;
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  return signal;
}
