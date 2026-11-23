import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { fetchBlob } from "./api";

/** Loads a protected file (image/SVG) with the user's token and exposes it as an object URL. */
export function useBlobUrl(path: string | null, deps: unknown[] = []) {
  const [url, setUrl] = useState<string | null>(null); const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  useEffect(() => {
    if (!path) { setUrl(null); setState("idle"); return; }
    let live = true, made = ""; setState("loading");
    fetchBlob(path).then((b) => { if (!live) return; made = URL.createObjectURL(b); setUrl(made); setState("ok"); }).catch(() => live && (setUrl(null), setState("error")));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  return { url, state };
}

export function AuthImg({ path, alt, className = "", version }: { path: string | null; alt: string; className?: string; version?: unknown }) {
  const { url, state } = useBlobUrl(path, [version]);
  if (url) return <img src={url} alt={alt} className={`object-cover ${className}`} />;
  return <div className={`flex items-center justify-center bg-muted text-sub ${state === "loading" ? "skeleton" : ""} ${className}`} aria-label={alt}>{state !== "loading" && <ImageOff className="h-1/3 w-1/3 opacity-50" />}</div>;
}

/** Opens a protected PDF in a new tab. */
export async function openPdf(path: string) {
  const w = window.open("", "_blank"); // opened synchronously so popup blockers allow it
  try { const url = URL.createObjectURL(await fetchBlob(path)); if (w) w.location.href = url; else window.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); }
  catch (e) { w?.close(); throw e; }
}
/** Prints a protected PDF through a hidden iframe. */
export async function printPdf(path: string) {
  const url = URL.createObjectURL(await fetchBlob(path));
  const f = document.createElement("iframe"); f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0"; f.src = url; document.body.appendChild(f);
  f.onload = () => { setTimeout(() => { f.contentWindow?.focus(); f.contentWindow?.print(); }, 200); setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 60000); };
}
export async function savePdf(path: string, filename: string) {
  const url = URL.createObjectURL(await fetchBlob(path)); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}