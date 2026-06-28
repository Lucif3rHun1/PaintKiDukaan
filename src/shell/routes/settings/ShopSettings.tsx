import { useEffect, useState } from "react";
import { toast } from "../../../lib/feedback/toast";
import { Button, Card, Section, Skeleton } from "../../../components/ui";
import { ipc } from "../../lib/ipc";
import { extractError } from "../../../lib/extractError";

export function ShopInfoSettings() {
  const [shopName, setShopName] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      ipc.getSetting("shop_name"),
      ipc.getSetting("phone"),
      ipc.getSetting("gstin"),
      ipc.getSetting("address"),
    ])
      .then(([name, ph, gst, addr]) => {
        setShopName(name ?? "");
        setPhone(ph ?? "");
        setGstin(gst ?? "");
        setAddress(addr ?? "");
      }).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        ipc.setSetting("shop_name", shopName),
        ipc.setSetting("phone", phone),
        ipc.setSetting("gstin", gstin),
        ipc.setSetting("address", address),
      ]);
      toast.success("Shop info saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-60" />;

  return (
    <Card>
      <Section
        title="Shop information"
        description="Name, phone, GSTIN, and address shown on invoices and receipts."
      >
        <div className="grid gap-4 text-sm">
          <Field label="Shop name">
            <input value={shopName} onChange={(e) => setShopName(e.target.value)} className="input" />
          </Field>
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
          </Field>
          <Field label="GSTIN">
            <input value={gstin} onChange={(e) => setGstin(e.target.value)} className="input" />
          </Field>
          <Field label="Address">
            <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} className="input" />
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>Save</Button>
          </div>
        </div>
      </Section>
    </Card>
  );
}

export function CurrencySettings() {
  const [code, setCode] = useState("INR");
  const [symbol, setSymbol] = useState("₹");
  const [decimals, setDecimals] = useState("2");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      ipc.getSetting("currency_code"),
      ipc.getSetting("currency_symbol"),
      ipc.getSetting("currency_decimal_places"),
    ])
      .then(([c, s, d]) => {
        setCode(c ?? "INR");
        setSymbol(s ?? "₹");
        setDecimals(d ?? "2");
      }).catch((err: unknown) => console.error("Silent catch replaced:", err))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await Promise.all([
        ipc.setSetting("currency_code", code),
        ipc.setSetting("currency_symbol", symbol),
        ipc.setSetting("currency_decimal_places", decimals),
      ]);
      toast.success("Currency settings saved");
    } catch (e) {
      toast.error("Failed to save", extractError(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Skeleton variant="card" className="h-40" />;

  return (
    <Card>
      <Section title="Currency" description="Currency code, symbol, and decimal display precision.">
        <div className="grid max-w-md gap-4 text-sm">
          <Field label="Currency code">
            <input value={code} onChange={(e) => setCode(e.target.value)} className="input" />
          </Field>
          <Field label="Symbol">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input" />
          </Field>
          <Field label="Decimal places">
            <input type="number" min={0} max={4} value={decimals} onChange={(e) => setDecimals(e.target.value)} className="input" />
          </Field>
          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>Save</Button>
          </div>
        </div>
      </Section>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}
