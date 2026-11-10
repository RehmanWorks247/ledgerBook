import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function CompanyDialog({ title, description, busy, onClose, children, compact = false }: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  compact?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className={`entry-dialog company-dialog${compact ? " company-dialog-compact" : ""}`}
      aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const element = event.currentTarget;
        const focusable = Array.from(element.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"))
          .filter(node => !node.matches(":disabled") && node.tabIndex >= 0 && node.getClientRects().length > 0);
        event.preventDefault();
        event.stopPropagation();
        if (!focusable.length) { element.focus(); return; }
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
        focusable[next].focus();
      }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close company dialog" disabled={busy} onClick={onClose}><X size={20} /></button>
      </div>
      <p id={descriptionId} className="company-dialog-description">{description}</p>
      {children}
    </dialog>
  );
}
