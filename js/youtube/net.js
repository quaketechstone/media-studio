/**
 * 网络相关的小工具。单独成文件是为了避免两个客户端各写一份，
 * 也避免它们互相 import 形成耦合。
 */

/**
 * 合并"用户取消"与"超时"两个信号。
 * 不做超时的话，执行器卡住时 UI 会无限转圈——比报错更难排查。
 *
 * 注意：超时触发的是 TimeoutError，用户取消是 AbortError。上游必须能区分这两者，
 * 否则"下载超时"会被显示成"你取消了下载"。
 */
export function withTimeout(signal, ms) {
  if (!ms || ms <= 0) return signal;
  if (AbortSignal.timeout && AbortSignal.any) {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  // 老环境兜底：自己造一个控制器，并在超时后带 TimeoutError 原因中止
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("请求超时", "TimeoutError"));
  }, ms);
  timer?.unref?.();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** 把多个取消信号并成一个。任意一个 abort 就整体中止。 */
export function mergeSignals(...signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
