import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutosave, type SaveStatus } from "./useAutosave";
import { useDirtyForm } from "./useDirtyForm";
import type { CartLine } from "../types";
import type { Draft } from "@/domain/types";
import { saveDraft, getDraft, deleteDraft } from "../api";
import { toast } from "../../lib/feedback/toast";
import { extractError } from "../../lib/extractError";

export interface CartState<TLine extends CartLine> {
  lines: TLine[];
  billDiscount: number;
  splits: Array<{ mode: string; amount: number }>;
  kind: "final" | "quotation" | "fbill";
  customerId: number | null;
  ackFlag: boolean;
  validityDays: number;
  vendorId: number | null;
  notes: string;
}

export interface DraftData {
  kind?: "final" | "quotation" | "fbill";
  customerId?: number | null;
  lines?: CartLine[];
  billDiscount?: number;
  splits?: Array<{ mode: string; amount: number }>;
  validityDays?: number;
  ackFlag?: boolean;
  vendorId?: number | null;
  notes?: string;
}

export interface UseCartOptions<TLine extends CartLine> {
  autosaveKey: string;
  initialLines?: TLine[];
  initialBillDiscount?: number;
  initialSplits?: Array<{ mode: string; amount: number }>;
  initialKind?: "final" | "quotation" | "fbill";
  initialCustomerId?: number | null;
  initialAckFlag?: boolean;
  initialValidityDays?: number;
  initialVendorId?: number | null;
  initialNotes?: string;
  serializeDraft: (state: CartState<TLine>) => DraftData;
  deserializeDraft: (data: DraftData) => Partial<CartState<TLine>>;
  onRestore?: (restored: Partial<CartState<TLine>>) => void;
}

export interface UseCartReturn<TLine extends CartLine> {
  // Lines
  lines: TLine[];
  addLine: (line: TLine) => void;
  removeLine: (id: string) => void;
  removeLineByIndex: (index: number) => void;
  updateLine: (index: number, patch: Partial<TLine>) => void;
  clearLines: () => void;

  // Bill-level state (sales)
  billDiscount: number;
  setBillDiscount: (v: number) => void;
  splits: Array<{ mode: string; amount: number }>;
  setSplits: (v: Array<{ mode: string; amount: number }>) => void;
  kind: "final" | "quotation" | "fbill";
  setKind: (v: "final" | "quotation" | "fbill") => void;
  customerId: number | null;
  setCustomerId: (v: number | null) => void;
  ackFlag: boolean;
  setAckFlag: (v: boolean) => void;
  validityDays: number;
  setValidityDays: (v: number) => void;

  // Purchase-level state
  vendorId: number | null;
  setVendorId: (v: number | null) => void;
  notes: string;
  setNotes: (v: string) => void;

  // Computed
  subtotal: number;
  lineDiscountTotal: number;
  total: number;
  paid: number;
  balance: number;

  // Draft / autosave
  draft: Draft | null;
  draftStatus: SaveStatus;
  draftLoading: boolean;
  resetDraft: () => void;

  // Dirty tracking
  isDirty: boolean;
  markDirty: () => void;
  resetDirty: () => void;
}

function computeSubtotal<TLine extends CartLine>(lines: TLine[]): number {
  return lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
}

function computeLineDiscountTotal<TLine extends CartLine>(lines: TLine[]): number {
  return lines.reduce((s, l) => s + l.line_discount, 0);
}

function computePaid(splits: Array<{ mode: string; amount: number }>): number {
  return splits.reduce((s, p) => s + p.amount, 0);
}

export function useCart<TLine extends CartLine>({
  autosaveKey,
  initialLines = [],
  initialBillDiscount = 0,
  initialSplits = [],
  initialKind = "final",
  initialCustomerId = null,
  initialAckFlag = false,
  initialValidityDays = 7,
  initialVendorId = null,
  initialNotes = "",
  serializeDraft,
  deserializeDraft,
  onRestore,
}: UseCartOptions<TLine>): UseCartReturn<TLine> {
  // Core line state
  const [lines, setLines] = useState<TLine[]>(initialLines);

  // Sales state
  const [billDiscount, setBillDiscount] = useState(initialBillDiscount);
  const [splits, setSplits] = useState<Array<{ mode: string; amount: number }>>(initialSplits);
  const [kind, setKind] = useState<"final" | "quotation" | "fbill">(initialKind);
  const [customerId, setCustomerId] = useState<number | null>(initialCustomerId);
  const [ackFlag, setAckFlag] = useState(initialAckFlag);
  const [validityDays, setValidityDays] = useState(initialValidityDays);

  // Purchase state
  const [vendorId, setVendorId] = useState<number | null>(initialVendorId);
  const [notes, setNotes] = useState(initialNotes);

  // Dirty tracking
  const { isDirty, markDirty, resetDirty } = useDirtyForm();

  // Autosave
  const draftData = useMemo(() => serializeDraft({
    lines,
    billDiscount,
    splits,
    kind,
    customerId,
    ackFlag,
    validityDays,
    vendorId,
    notes,
  }), [lines, billDiscount, splits, kind, customerId, ackFlag, validityDays, vendorId, notes, serializeDraft]);

  const { draft, loading: draftLoading, status: draftStatus, resetDraft } = useAutosave(autosaveKey, draftData);

  // Mark dirty when draft data changes (after initial load)
  const draftLoadedRef = useRef(false);
  useEffect(() => {
    if (!draftLoading && draft && (lines.length > 0 || billDiscount !== 0 || splits.length > 0 || notes)) {
      if (!draftLoadedRef.current) {
        draftLoadedRef.current = true;
        markDirty();
      }
    }
  }, [draftLoading, draft, lines, billDiscount, splits, notes, markDirty]);

  // Restore draft on mount
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!draftLoading && draft) {
      restoredRef.current = true;
      try {
        const data = JSON.parse(draft.data_json) as DraftData;
        const restored = deserializeDraft(data);
        if (restored.lines) setLines(restored.lines as TLine[]);
        if (restored.billDiscount != null) setBillDiscount(restored.billDiscount);
        if (restored.splits) setSplits(restored.splits);
        if (restored.kind) setKind(restored.kind);
        if (restored.customerId != null) setCustomerId(restored.customerId);
        if (restored.ackFlag != null) setAckFlag(restored.ackFlag);
        if (restored.validityDays != null) setValidityDays(restored.validityDays);
        if (restored.vendorId != null) setVendorId(restored.vendorId);
        if (restored.notes != null) setNotes(restored.notes);
        onRestore?.(restored);
      } catch {
        resetDraft();
      }
    }
  }, [draftLoading, draft, deserializeDraft, onRestore, resetDraft]);

  // Page badge dispatch
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
      detail: { status: draftStatus, draft },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent("paintkiduakan:page-badge", {
        detail: { status: "idle", draft: null },
      }));
    };
  }, [draftStatus, draft]);

  // Line mutations
  const addLine = useCallback((line: TLine) => {
    setLines((prev) => [...prev, line]);
    markDirty();
  }, [markDirty]);

  const removeLine = useCallback((id: string) => {
    setLines((prev) => prev.filter((l) => (l as unknown as { row_id?: string }).row_id !== id));
    markDirty();
  }, [markDirty]);

  const removeLineByIndex = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
    markDirty();
  }, [markDirty]);

  const updateLine = useCallback((index: number, patch: Partial<TLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
    markDirty();
  }, [markDirty]);

  const clearLines = useCallback(() => {
    setLines([]);
    markDirty();
  }, [markDirty]);

  // Computed totals
  const subtotal = useMemo(() => computeSubtotal(lines), [lines]);
  const lineDiscountTotal = useMemo(() => computeLineDiscountTotal(lines), [lines]);
  const total = useMemo(() => Math.max(0, subtotal - lineDiscountTotal - billDiscount), [subtotal, lineDiscountTotal, billDiscount]);
  const paid = useMemo(() => computePaid(splits), [splits]);
  const balance = total - paid;

  return {
    lines,
    addLine,
    removeLine,
    removeLineByIndex,
    updateLine,
    clearLines,

    billDiscount,
    setBillDiscount,
    splits,
    setSplits,
    kind,
    setKind,
    customerId,
    setCustomerId,
    ackFlag,
    setAckFlag,
    validityDays,
    setValidityDays,

    vendorId,
    setVendorId,
    notes,
    setNotes,

    subtotal,
    lineDiscountTotal,
    total,
    paid,
    balance,

    draft,
    draftStatus,
    draftLoading,
    resetDraft,

    isDirty,
    markDirty,
    resetDirty,
  };
}