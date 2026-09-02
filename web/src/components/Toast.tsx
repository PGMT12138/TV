import React from 'react';
import { useApp } from '../context/AppContext';
import { CheckCircle2, Info, AlertTriangle } from 'lucide-react';

export const ToastContainer: React.FC = () => {
  const { toasts } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div id="toast-container" className="fixed bottom-20 md:bottom-8 right-4 md:right-8 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-zinc-900/95 backdrop-blur-md border border-zinc-800 text-zinc-100 shadow-2xl animate-fade-blur pointer-events-auto"
          style={{
            boxShadow: 'rgba(0, 0, 0, 0.6) 0px 20px 40px -10px, rgba(255, 255, 255, 0.05) 0px 0px 0px 1px',
          }}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
          {(!toast.type || toast.type === 'info') && <Info className="w-5 h-5 text-indigo-400 shrink-0" />}
          <span className="text-sm font-medium tracking-wide">{toast.message}</span>
        </div>
      ))}
    </div>
  );
};
