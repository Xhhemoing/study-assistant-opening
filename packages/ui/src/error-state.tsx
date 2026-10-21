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
    <div className={`rounded-card border border-line bg-surface p-4 text-text ${className}`} role="alert">
      <div className="flex items-start gap-2">
        <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          {title ? <h2 className="text-base font-medium">{title}</h2> : null}
          <p className="break-words text-sm leading-6 text-text-2">{message}</p>
        </div>
      </div>
      {onRetry ? <Button variant="secondary" className="mt-3" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />{retryLabel}</Button> : null}
    </div>
  );
}
