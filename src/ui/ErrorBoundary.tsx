// Owned by: ui
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { copyAndToast } from './toast';

type Props = {
  /** Screen name for the message: "Watch", "Gym", "Room". */
  label: string;
  children: ReactNode;
  /** Runs before a retry, to clear state that would crash the same way again. */
  onReset?: () => void;
};

type State = { error: Error | null; stack: string };

/**
 * Keeps a bug in one screen from blanking the whole app: the other tabs (and a running batch or an
 * unsaved strategy in them) stay alive, and the broken screen offers a retry and the details to
 * report.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`The ${this.props.label} screen crashed.`, error);
    this.setState({ stack: info.componentStack ?? '' });
  }

  private retry = () => {
    this.props.onReset?.();
    this.setState({ error: null, stack: '' });
  };

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const details = `${this.props.label} screen: ${error.name}: ${error.message}\n${error.stack ?? ''}\n${stack}`;
    return (
      <div className="crash" role="alert">
        <h2>The {this.props.label} screen tripped over something</h2>
        <p>That is a bug in the Pit, not in your strategy. The other screens still work.</p>
        <p className="crash-msg num">{error.message || error.name}</p>
        <div className="crash-actions">
          <button type="button" className="btn btn-primary" onClick={this.retry}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => void copyAndToast(details, 'Error details')}>
            Copy details
          </button>
        </div>
      </div>
    );
  }
}
