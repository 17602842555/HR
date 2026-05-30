import React from "react";
import { X } from "lucide-react";

export function Modal({ children, onClose, title, wide = false }) {
  if (!title) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <section className={wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        {children}
      </section>
    </div>
  );
}
