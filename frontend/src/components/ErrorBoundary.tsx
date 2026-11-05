import { Component, type ReactNode } from "react";

interface Props {
  fallback: (message: string) => ReactNode;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { message: string | null }> {
  override state = { message: null as string | null };

  static getDerivedStateFromError(cause: unknown) {
    return { message: cause instanceof Error ? cause.message : String(cause) };
  }

  override render() {
    return this.state.message !== null
      ? this.props.fallback(this.state.message)
      : this.props.children;
  }
}
