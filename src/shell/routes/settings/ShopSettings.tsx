import { useEffect, useMemo, useState } from "react";
import { toast } from "../../../lib/feedback/toast";
import { Alert, Badge, Button, Card, Field, Section, Skeleton } from "../../../components/ui";
import { useDirtyForm } from "../../../pos/hooks/useDirtyForm";
import { ipc } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function ShopInfoSettings() {
  const [shopName, setShopName] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [baseline, setBaseline] = useState({ name: "", phone: "", gstin: "", address: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gstinError, setGstinError] = useState<string | null>(null);
  const { markDirty, resetDirty } = useDirtyForm();

  useEffect(() => {
    Promise.all([
      ipc.getSetting("shop_name"),
      ipc.getSetting("phone"),
      ipc.getSetting("gstin"),
      ipc.getSetting("address"),
    ])
      .then(([name, ph, gst, addr]) => {
        const loaded = {
          name: name ?? "",
          phone: ph ?? "",
          gstin: gst ?? "",
          address: addr ?? "",
        };
        setShopName(loaded.name);
        setPhone(loaded.phone);
        setGstin(loaded.gstin);
        setAddress(loaded.address);
        setBaseline(loaded);
      }).catch((err: unknown) => toast.error("Failed to load settings", extractError(err)))
      .finally(() => setLoading(false));
  }, []);

  const isDirty = useMemo(
    () => shopName !== baseline.name || phone !== baseline.phone || gstin !== baseline.gstin || address !== baseline.address,
    [shopName, phone, gstin, address, baseline],
  );

  useEffect(() => {
    if (isDirty) markDirty();
    else resetDirty();
  }, [isDirty, markDirty, resetDirty]);

  useEffect(() => () => resetDirty(), [resetDirty]);

  async function save() {
    if (gstin.trim() && !GSTIN_PATTERN.test(gstin.trim().toUpperCase())) {
      setGstinError("Enter a valid 15-character GSTIN or leave it blank.");
      return;
    }
    setGstinError(null);
    setSaving(true);
    try {
      await ipc.setSetting("shop_name", shopName);
      await ipc.setSetting("phone", phone);
      await ipc.setSetting("gstin", gstin);
      await ipc.setSetting("address", address);
      setBaseline({ name: shopName, phone, gstin, address });
      toast.success("Shop info saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-60" />;

  return (
    <div className="space-y-3">
      <Card depth="raised">
        <Card.Body className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">Shop profile</h2>
              <Badge variant={shopName.trim() ? "success" : "warning"}>{shopName.trim() ? "Configured" : "Name required"}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{shopName.trim() || "No shop name has been saved."}</p>
          </div>
          <Badge variant={baseline.gstin.trim() ? "info" : "muted"}>{baseline.gstin.trim() ? "GSTIN recorded" : "GSTIN not set"}</Badge>
        </Card.Body>
      </Card>
      {!shopName.trim() ? <Alert variant="warning" title="Shop identity is incomplete">Enter the shop name, then save before issuing customer documents.</Alert> : null}
      <Card depth="flat">
        <Section title="Shop information" description="Name, phone, GSTIN, and address shown on invoices and receipts.">
          <div className="grid gap-4 rounded-lg bg-surface-sunken p-4 text-sm">
          <Field label="Shop name" htmlFor="shop-name" required>
            <input id="shop-name" aria-label="Shop name" value={shopName} onChange={(e) => setShopName(e.target.value)} className="input" />
          </Field>
          <Field label="Phone" htmlFor="shop-phone">
            <input id="shop-phone" aria-label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
          </Field>
          <Field label="GSTIN" htmlFor="shop-gstin" error={gstinError ?? undefined} hint="Optional. Must be a valid 15-character GSTIN when entered.">
            <input
              id="shop-gstin"
              aria-label="GSTIN"
              value={gstin}
              onChange={(e) => {
                setGstin(e.target.value);
                if (gstinError) setGstinError(null);
              }}
              className="input"
              aria-invalid={gstinError ? true : undefined}
            />
          </Field>
          <Field label="Address" htmlFor="shop-address">
            <textarea id="shop-address" aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} rows={3} className="input" />
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>Save</Button>
          </div>
          </div>
        </Section>
      </Card>
    </div>
  );
}

export function CurrencySettings() {
  const [code, setCode] = useState("INR");
  const [symbol, setSymbol] = useState("₹");
  const [decimals, setDecimals] = useState("2");
  const [baseline, setBaseline] = useState({ code: "INR", symbol: "₹", decimals: "2" });
  const [hasSavedValue, setHasSavedValue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [decimalsError, setDecimalsError] = useState<string | null>(null);
  const { markDirty, resetDirty } = useDirtyForm();

  useEffect(() => {
    Promise.all([
      ipc.getSetting("currency_code"),
      ipc.getSetting("currency_symbol"),
      ipc.getSetting("currency_decimal_places"),
    ])
      .then(([c, s, d]) => {
        const loaded = {
          code: c ?? "INR",
          symbol: s ?? "₹",
          decimals: d ?? "2",
        };
        setCode(loaded.code);
        setSymbol(loaded.symbol);
        setDecimals(loaded.decimals);
        setBaseline(loaded);
        setHasSavedValue(c !== null || s !== null || d !== null);
      }).catch((err: unknown) => toast.error("Failed to load settings", extractError(err)))
      .finally(() => setLoading(false));
  }, []);

  const isDirty = useMemo(
    () => code !== baseline.code || symbol !== baseline.symbol || decimals !== baseline.decimals,
    [code, symbol, decimals, baseline],
  );

  useEffect(() => {
    if (isDirty) markDirty();
    else resetDirty();
  }, [isDirty, markDirty, resetDirty]);

  useEffect(() => () => resetDirty(), [resetDirty]);

  async function save() {
    const decimalValue = decimals.trim();
    if (!/^[0-4]$/.test(decimalValue)) {
      setDecimalsError("Use a whole number from 0 to 4.");
      return;
    }
    setDecimalsError(null);
    setSaving(true);
    try {
      await ipc.setSetting("currency_code", code);
      await ipc.setSetting("currency_symbol", symbol);
      await ipc.setSetting("currency_decimal_places", decimalValue);
      setBaseline({ code, symbol, decimals: decimalValue });
      setDecimals(decimalValue);
      setHasSavedValue(true);
      toast.success("Currency settings saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-40" />;

  return (
    <div className="space-y-3">
      <Card depth="raised">
        <Card.Body className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">Currency state</h2>
              <Badge variant={hasSavedValue ? "success" : "muted"}>{hasSavedValue ? "Configured" : "Default"}</Badge>
            </div>
            <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{code} · {symbol} · {decimals} decimal places</p>
          </div>
          <Badge variant="info">Used across billing</Badge>
        </Card.Body>
      </Card>
      <Alert variant="info" title="Currency changes affect displayed amounts">Confirm the code, symbol, and precision, then save to apply the next action.</Alert>
      <Card depth="flat">
        <Section title="Currency" description="Currency code, symbol, and decimal display precision.">
          <div className="grid max-w-md gap-4 rounded-lg bg-surface-sunken p-4 text-sm">
          <Field label="Currency code" htmlFor="currency-code">
            <input id="currency-code" aria-label="Currency code" value={code} onChange={(e) => setCode(e.target.value)} className="input" />
          </Field>
          <Field label="Symbol" htmlFor="currency-symbol">
            <input id="currency-symbol" aria-label="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input" />
          </Field>
          <Field label="Decimal places" htmlFor="currency-decimals" error={decimalsError ?? undefined} hint="Whole number from 0 to 4.">
            <input
              id="currency-decimals"
              aria-label="Decimal places"
              type="number"
              min={0}
              max={4}
              value={decimals}
              onChange={(e) => {
                setDecimals(e.target.value);
                if (decimalsError) setDecimalsError(null);
              }}
              className="input"
              aria-invalid={decimalsError ? true : undefined}
            />
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>Save</Button>
          </div>
          </div>
        </Section>
      </Card>
    </div>
  );
}
