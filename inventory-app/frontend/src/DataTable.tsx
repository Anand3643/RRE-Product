import { ReactNode, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, GripVertical } from "lucide-react";
import { Checkbox } from "./fx";
import { Skeleton } from "./ui";

export type Col<T> = { id: string; label: string; sort?: string; right?: boolean; w: number; cell: (r: T) => ReactNode };

/**
 * The shared list table: sortable headers, drag-to-reorder columns (remembered per `storageKey`), optional row
 * selection, keyboard navigation (↑↓ move, Enter opens, Space selects), hover-revealed row actions, loading dimming
 * and staggered row entrance. Page-level concerns (filters, bulk bar, pagination) stay in the page.
 */
export function DataTable<T>({ storageKey, columns, rows, rowKey, loading, hasData, sort, desc, onSort, selected, onToggle, onToggleAll, onRowOpen, rowActions, empty, minWidth = 860, animKey, actionsWidth = 96 }: {
  storageKey: string; columns: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; loading?: boolean; hasData?: boolean;
  sort: string; desc: boolean; onSort: (key: string) => void;
  selected?: Map<string | number, T>; onToggle?: (r: T) => void; onToggleAll?: (v: boolean) => void;
  onRowOpen?: (r: T) => void; rowActions?: (r: T) => ReactNode; empty: ReactNode; minWidth?: number; animKey?: string; actionsWidth?: number;
}) {
  const ids = columns.map((c) => c.id);
  const load = (): string[] => { try { const o = JSON.parse(localStorage.getItem(storageKey) || "[]"); return o.length === ids.length && ids.every((i) => o.includes(i)) ? o : ids; } catch { return ids; } };
  const [order, setOrder] = useState<string[]>(load);
  const [dragId, setDragId] = useState<string | null>(null); const [overId, setOverId] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(order)); } catch { /* ignore */ } }, [order, storageKey]);
  const cols = order.map((id) => columns.find((c) => c.id === id)!).filter(Boolean);
  const customised = order.join() !== ids.join();
  const sel = !!selected; const allOn = rows.length > 0 && !!selected && rows.every((r) => selected.has(rowKey(r))); const someOn = !!selected && rows.some((r) => selected.has(rowKey(r)));

  const drop = (target: string) => {
    if (!dragId || dragId === target) return;
    const o = order.filter((i) => i !== dragId); o.splice(o.indexOf(target) + (order.indexOf(dragId) < order.indexOf(target) ? 1 : 0), 0, dragId);
    setOrder(o); setDragId(null); setOverId(null);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTableRowElement>, r: T) => {
    const tr = e.currentTarget;
    if (e.key === "ArrowDown") { e.preventDefault(); (tr.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (tr.previousElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === "Enter" && onRowOpen) { e.preventDefault(); onRowOpen(r); }
    else if (e.key === " " && onToggle) { e.preventDefault(); onToggle(r); }
  };

  if (loading && !hasData) return <Skeleton />;
  if (!rows.length) return <>{empty}</>;
  return (
    <div className={`overflow-x-auto transition-opacity duration-150 ${loading ? "opacity-60" : ""}`}>
      {customised && <div className="flex justify-end px-3 pt-1"><button className="text-xs text-brand hover:underline" onClick={() => setOrder(ids)}>Reset columns</button></div>}
      <table className="w-full table-fixed" style={{ minWidth }}>
        <colgroup>{sel && <col style={{ width: "36px" }} />}{cols.map((c) => <col key={c.id} style={{ width: `${c.w}%` }} />)}{rowActions && <col style={{ width: `${actionsWidth}px` }} />}</colgroup>
        <thead className="border-b bg-muted/60"><tr>
          {sel && <th className="th w-9 !pr-0"><Checkbox label="Select all on this page" checked={allOn} indeterminate={!allOn && someOn} onChange={(v) => onToggleAll?.(v)} /></th>}
          {cols.map((c) => (
            <th key={c.id} draggable onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); }}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(c.id); } }} onDragEnd={() => { setDragId(null); setOverId(null); }} onDrop={(e) => { e.preventDefault(); drop(c.id); }}
              onClick={c.sort ? () => onSort(c.sort!) : undefined} aria-sort={c.sort && sort === c.sort ? (desc ? "descending" : "ascending") : undefined}
              className={`th group select-none transition-colors ${c.right ? "text-right" : ""} ${c.sort ? "cursor-pointer hover:text-ink" : "cursor-grab"} ${c.sort && sort === c.sort ? "text-ink" : ""} ${dragId === c.id ? "opacity-40" : ""} ${overId === c.id && dragId !== c.id ? "!shadow-[inset_2px_0_0_rgb(var(--brand))]" : ""}`}>
              <span className={`inline-flex items-center gap-1 ${c.right ? "flex-row-reverse" : ""}`}><GripVertical className="h-3 w-3 shrink-0 cursor-grab opacity-0 transition-opacity group-hover:opacity-40" />{c.label}
                {c.sort && (sort === c.sort ? (desc ? <ArrowDown className="h-3 w-3 text-brand" /> : <ArrowUp className="h-3 w-3 text-brand" />) : <ArrowUpDown className="h-3 w-3 opacity-30" />)}</span></th>))}
          {rowActions && <th className="th" />}</tr></thead>
        <tbody key={animKey} className="divide-y">{rows.map((r, i) => { const k = rowKey(r); const on = !!selected?.has(k); return (
          <tr key={k} tabIndex={0} onKeyDown={(e) => onKey(e, r)} onClick={() => onRowOpen?.(r)} aria-selected={on} style={{ ["--i" as any]: i }}
            className={`stagger outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus-visible:shadow-[inset_3px_0_0_rgb(var(--brand))] ${onRowOpen ? "cursor-pointer" : ""} ${on ? "!bg-brand/[0.07]" : ""}`}>
            {sel && <td className="td !pr-0"><Checkbox label="Select row" checked={on} onChange={() => onToggle?.(r)} /></td>}
            {cols.map((c) => <Fragment key={c.id}>{c.cell(r)}</Fragment>)}
            {rowActions && <td className="td text-right" onClick={(e) => e.stopPropagation()}>{rowActions(r)}</td>}</tr>); })}</tbody>
      </table>
    </div>
  );
}
const Fragment = ({ children }: { children: ReactNode }) => <>{children}</>;
