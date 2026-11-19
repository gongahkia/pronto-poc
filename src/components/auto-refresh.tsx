"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalMs = 20000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" &&
          !document.querySelector('dialog[open]') &&
          !document.activeElement?.matches("input, textarea, select")) router.refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, router]);

  return null;
}
