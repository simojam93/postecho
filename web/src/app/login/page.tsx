"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/");
        return;
      }
      let msg = "login failed";
      try {
        const data = await res.json();
        if (typeof data.error === "string") msg = data.error;
      } catch {}
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-4">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <BrandMark className="h-6 w-auto text-accent" />
          <span><span className="text-text-dim">Post</span>Echo</span>
        </h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-text-dim"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded-full bg-accent px-3 py-2 font-medium text-accent-ink hover:bg-white disabled:opacity-60"
        >
          Enter
        </button>
      </form>
    </main>
  );
}
