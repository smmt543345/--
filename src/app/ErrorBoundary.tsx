/**
 * 渲染期错误兜底（04 §4、§6）。
 *
 * useLiveQuery 在查询失败时是**渲染期抛出**的，没有边界就是整页白屏——
 * 而白屏对着用户等于"应用坏了"，连去设置页导出的机会都没有。
 * 这里至少把原始报错摊开给用户看，并给一个刷新的出口。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留全量堆栈，界面只放人话
    console.error('界面渲染出错：', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">界面出了点问题</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          数据仍在本机数据库里，没有丢。刷新页面通常能恢复；若反复出现，请把下面的信息记下来。
        </p>
        <pre className="max-h-64 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs whitespace-pre-wrap text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
          {error.message}
        </pre>
        <button
          type="button"
          className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          onClick={() => {
            window.location.reload();
          }}
        >
          刷新页面
        </button>
      </div>
    );
  }
}
