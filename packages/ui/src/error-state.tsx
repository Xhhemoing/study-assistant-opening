import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "./button";

export type ErrorStateProps = {
  message: string;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorState({ message, title, onRetry, retryLabel = "重新读取", className = "" }: ErrorStateProps) {
  return (
    <div className={`rounded-card border border-danger/25 bg-surface p-4 text-text shadow-card ${className}`} role="alert">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger" aria-hidden="true">
          <AlertCircle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {title ? <h2 className="text-base font-medium text-text">{title}</h2> : null}
          <p className="break-words text-sm leading-6 text-text-2">{message}</p>
        </div>
      </div>
      {onRetry ? <Button variant="secondary" className="mt-3" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />{retryLabel}</Button> : null}
    </div>
  );
}
