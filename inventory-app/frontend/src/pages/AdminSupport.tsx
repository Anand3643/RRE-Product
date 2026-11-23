import { useState } from "react";
import { api, dt } from "../api";
import { Badge, Empty, Skeleton, useLoad, useToast } from "../ui";

export default function AdminSupport() {
  const toast = useToast(); const [status, setStatus] = useState("open"); const d = useLoad(() => api(`/support${status ? `?status=${status}` : ""}`), [status]);
  const [reply, setReply] = useState<Record<number, string>>({});
  const send = async (id: number, close: boolean) => { try { await api(`/support/${id}/reply`, { body: { reply: reply[id], status: close ? "closed" : "answered" } }); toast("Reply sent"); setReply({ ...reply, [id]: "" }); d.reload(); } catch (e: any) { toast(e.message, "err"); } };
  return (
    <div className="space-y-4" data-testid="admin-support">
      <div className="flex items-center justify-between"><div><h1 className="text-xl font-semibold">Support tickets</h1><p className="text-[13px] text-sub">Requests raised by users from the user portal.</p></div>
        <select className="input !w-auto" aria-label="Ticket status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="open">Open</option><option value="answered">Answered</option><option value="closed">Closed</option></select></div>
      {d.loading && !d.data ? <div className="card"><Skeleton rows={4} /></div> : !d.data?.length ? <div className="card"><Empty title="No tickets" /></div> : d.data.map((t: any) => (
        <div key={t.id} className="card space-y-2 p-4 text-[13px]" data-ticket={t.id}>
          <div className="flex items-center justify-between"><span><b className="font-medium">{t.subject}</b><span className="ml-2 text-sub">{t.user} · {t.email} · {dt(t.created_at)}</span></span><Badge tone={t.status === "open" ? "warn" : t.status === "answered" ? "ok" : "neutral"}>{t.status}</Badge></div>
          <p className="whitespace-pre-wrap">{t.message}</p>
          {t.reply && <p className="rounded-lg bg-muted p-2 text-sub"><b className="font-medium text-ink">Your reply:</b> {t.reply}</p>}
          {t.status !== "closed" && <div className="flex gap-2"><input className="input" placeholder="Write a reply" aria-label={`Reply to ticket ${t.id}`} value={reply[t.id] || ""} onChange={(e) => setReply({ ...reply, [t.id]: e.target.value })} /><button className="btn-primary" disabled={!reply[t.id]} onClick={() => send(t.id, false)}>Reply</button><button className="btn-ghost" disabled={!reply[t.id]} onClick={() => send(t.id, true)}>Reply &amp; close</button></div>}
        </div>))}
    </div>
  );
}
