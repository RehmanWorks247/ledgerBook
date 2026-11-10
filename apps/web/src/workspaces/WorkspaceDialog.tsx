import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function WorkspaceDialog({ title, description, locked, onClose, children }: {
  title: string;
  description: string;
  locked: boolean;
  onClose: () => void;
  children: ReactNode;
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
    <dialog ref={dialog} className="entry-dialog workspace-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const element = event.currentTarget;
        const focusable = Array.from(element.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"))
          .filter(node => !node.matches(":disabled") && node.tabIndex >= 0 && node.getClientRects().length > 0);
        event.preventDefault();
        event.stopPropagation();
        if (!focusable.length) { element.focus(); return; }
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        // Safari can skip buttons according to system keyboard preferences.
        // Move every step explicitly so all actions remain reachable, rather
        // than only wrapping at a last button Safari may never focus.
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
        focusable[next].focus();
      }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close workspace dialog" disabled={locked} onClick={onClose}><X size={20} /></button>
      </div>
      <p id={descriptionId} className="muted">{description}</p>
      {children}
    </dialog>
  );
}
