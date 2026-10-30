/* tslint:disable */
/* eslint-disable */

/**
 * 把逐段译文合并回原文文档，返回 `{ document, warnings }`。
 */
export function apply_translations(doc_json: string, target: number, translations_json: string, format: string): string;

export function core_version(): string;

/**
 * 解析字幕文本。`hint` 为空串时按内容自动探测格式。
 */
export function parse_subtitles(text: string, hint: string): string;

/**
 * 分段。`target` 为期望段数（3/4/5，越界会被夹到区间内）。
 */
export function segment_subtitles(doc_json: string, target: number): string;

/**
 * 序列化文档。`format` 为空串时沿用文档自身格式。
 */
export function serialize_subtitles(doc_json: string, format: string): string;

export function start(): void;

/**
 * 与前端 `TextEncoder` 一致的 UTF-8 字节长度。
 */
export function utf8_byte_len(text: string): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly apply_translations: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly core_version: () => [number, number];
    readonly parse_subtitles: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly segment_subtitles: (a: number, b: number, c: number) => [number, number, number, number];
    readonly serialize_subtitles: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly start: () => void;
    readonly utf8_byte_len: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
