// 编辑器用的运行时全局声明：只提供补全与跳转提示，不参与构建，也不做类型检查。
// 这些对象由酒馆页面与扩展加载器注入，扩展代码从不 import 它们。

/** 酒馆前端主入口，getContext() 返回当前聊天、事件总线等运行时引用。 */
declare const SillyTavern: {
  getContext(): {
    eventSource?: { on(event: string, handler: (...args: unknown[]) => unknown): void };
    event_types?: Record<string, string>;
    chat?: unknown[];
    chatId?: string;
    chatMetadata?: Record<string, unknown>;
    characters?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** 酒馆全局通知组件。 */
declare const toastr: {
  info(message: string, title?: string): void;
  success(message: string, title?: string): void;
  warning(message: string, title?: string): void;
  error(message: string, title?: string): void;
};

/** 页面内置的 jQuery 实例。 */
declare const $: unknown;
declare const jQuery: unknown;
