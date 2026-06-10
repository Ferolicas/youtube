"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck } from "lucide-react";

export function MarkSeenButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/alerts", { method: "POST" }).catch(() => undefined);
        router.refresh();
        setBusy(false);
      }}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-xs font-medium text-fg hover:bg-border disabled:opacity-50"
    >
      <CheckCheck size={13} /> Marcar todo como leído
    </button>
  );
}
